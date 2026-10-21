/**
 * Schéma du projet : il pilote les formulaires, les colonnes des fichiers et le filtre.
 * La saisie se réduit à l'identification du matériel et à une note libre — tout
 * le reste d'une ligne est produit par l'application : position, méthode de
 * mesure, horodatage, référence.
 */
(function (global) {
  'use strict';

  /**
   * Identification du matériel en trois listes liées.
   * Les valeurs ne sont pas ici : elles viennent du catalogue (`parametres.csv`),
   * modifiable sans toucher au code. Le niveau 1 seul est obligatoire — beaucoup
   * d'ouvrages anciens n'ont ni modèle ni détail identifiables sur le terrain.
   */
  var CHAMPS_CASCADE = [
    { cle: 'type_materiel', label: 'Type de matériel', type: 'cascade', requis: true },
    { cle: 'modele', label: 'Modèle', type: 'cascade' },
    { cle: 'detail', label: 'Détail', type: 'cascade' }
  ];

  /**
   * La note de terrain. Le catalogue décrit ce qu'est l'ouvrage, jamais ce qui
   * cloche : tampon scellé, accès par la cour du 12, vanne bloquée, repère à
   * reprendre. Sans ce champ, ces constats se perdent entre le relevé et le
   * bureau — c'est ce qui a justifié son retour après la v0.7.
   */
  var CHAMP_OBSERVATIONS = {
    cle: 'observations', label: 'Observations', type: 'textarea',
    placeholder: "Accès, état, repère… ce que le catalogue ne dit pas"
  };

  /**
   * Date du dernier contrôle réglementaire de l'installation (contrôle de bon
   * fonctionnement). Avec le résultat, **exception assumée** à la règle « cascade + note » : la date
   * vient d'un dossier, pas du terrain, et Groma ne peut pas la produire. Elle
   * sert à repérer dans QGIS les installations à recontrôler (décision de Yoann,
   * 21/10/2026). Format AAAA-MM-JJ, celui du champ `date` du navigateur.
   */
  var CHAMP_DATE_CONTROLE = {
    cle: 'date_dernier_controle', label: 'Date du dernier contrôle', type: 'date',
    requisAvec: 'resultat_controle'
  };

  /**
   * Conclusion du même contrôle, selon les classes de l'arrêté du 27 avril 2012
   * (contrôle des installations d'ANC) : elles n'entraînent pas les mêmes
   * obligations de travaux, un simple « conforme / non conforme » les confondrait.
   * Liste réglementaire, pas du matériel : elle vit ici et non dans le catalogue.
   * Libellés en clair, c'est ce que QGIS affiche et sur quoi il classe.
   */
  var CHAMP_RESULTAT_CONTROLE = {
    cle: 'resultat_controle', label: 'Résultat du contrôle', type: 'liste',
    requisAvec: 'date_dernier_controle',
    options: [
      'Conforme',
      'Non conforme, travaux sous 4 ans',
      'Non conforme, travaux en cas de vente',
      "Absence d'installation"
    ]
  };

  var FILIERES = [
    {
      id: 'eau',
      label: 'EAU',
      labelCourt: 'EAU',
      titre: 'Eau potable (AEP)',
      couleur: '#0ea5e9',
      icone: 'goutte',
      prefixe: 'AEP',
      fichier: 'eau.geojson'
    },
    {
      id: 'assainissement',
      label: 'ASSAINISSEMENT',
      labelCourt: 'ASSAIN.',
      titre: 'Assainissement collectif',
      couleur: '#22c55e',
      icone: 'station',
      prefixe: 'AC',
      fichier: 'assainissement.geojson'
    },
    {
      id: 'spanc',
      label: 'SPANC',
      labelCourt: 'SPANC',
      titre: 'Assainissement non collectif',
      couleur: '#a855f7',
      icone: 'fosse',
      prefixe: 'ANC',
      champs: [CHAMP_DATE_CONTROLE, CHAMP_RESULTAT_CONTROLE],
      // Une installation ANC se trouve chez un particulier : la position seule
      // désigne un foyer, même sans nom ni adresse. Cf. docs/RGPD.md.
      fichier: 'spanc.geojson'
    },
    {
      id: 'voirie',
      label: 'VOIRIE',
      labelCourt: 'VOIRIE',
      titre: 'Voirie et espace public',
      // Orange chantier : distinct des trois autres filières et du jaune réservé
      // aux boutons d'action.
      couleur: '#ff8a3d',
      icone: 'candelabre',
      prefixe: 'VOI',
      fichier: 'voirie.geojson'
    }
  ];

  // Colonnes produites par l'application, jamais saisies.
  // Le bloc méthode / mesures / dispersion trace COMMENT le point a été pris :
  // sans lui, impossible de savoir si une coordonnée vaut 3 m ou 30 m.
  var COLONNES_TECHNIQUES = [
    'id', 'filiere', 'reference', 'date_saisie', 'operateur',
    'latitude', 'longitude', 'altitude_m',
    'precision_m', 'dispersion_m', 'methode_gps', 'nb_mesures', 'duree_gps_s',
    'position_ajustee', 'ecart_ajustement_m',
    'x_l93', 'y_l93'
  ];

  /**
   * Décimales de chaque colonne numérique. La table est ici, et pas dans le code
   * qui enregistre, parce que deux chemins produisent des relevés — la saisie et
   * l'import d'un fichier. Deux écritures d'une même valeur (`47.5175` d'un côté,
   * `47.5175000` de l'autre) rendraient deux exports incomparables à mesure
   * identique.
   *
   * Sept décimales de latitude valent le centimètre : en deçà on tronquerait la
   * mesure du récepteur, au-delà on afficherait du bruit de calcul.
   */
  var DECIMALES = {
    latitude: 7, longitude: 7, altitude_m: 2,
    precision_m: 1, dispersion_m: 2, duree_gps_s: 1, ecart_ajustement_m: 2,
    x_l93: 2, y_l93: 2
  };

  /**
   * Colonnes d'une filière, dans l'ordre du fichier. SPANC a deux colonnes de
   * plus que les autres (`date_dernier_controle`, `resultat_controle`). Chaque filière garde son fichier : la colonne « filiere » sert de garde-fou
   * à l'import, et rien ne les oblige à rester alignées.
   */
  function colonnesFiliere(filiereId) {
    if (!filiere(filiereId)) return [];
    return COLONNES_TECHNIQUES.concat(champsDe(filiereId).map(function (c) { return c.cle; }));
  }

  /**
   * Colonnes retirées de l'export SIG. Elles décrivent l'acquisition GPS, pas
   * l'ouvrage, et l'agent recale souvent le point sur la photo aérienne : la
   * précision du récepteur ne décrit alors plus la position écrite (décision de
   * Yoann, 21/10/2026). Le fichier de travail les garde toutes — c'est lui qui
   * sert à la sauvegarde et au réimport.
   *
   * Retirées aussi, parce que redondantes dans QGIS : `filiere` (une seule valeur
   * par fichier) et `x_l93` / `y_l93` (la géométrie porte la position, QGIS
   * reprojette). `id` reste : c'est la seule clé stable pour une jointure.
   */
  var COLONNES_HORS_SIG = [
    'filiere', 'x_l93', 'y_l93',
    'precision_m', 'dispersion_m', 'methode_gps', 'nb_mesures', 'duree_gps_s',
    'position_ajustee', 'ecart_ajustement_m'
  ];

  function colonnesSig(filiereId) {
    return colonnesFiliere(filiereId).filter(function (c) {
      return COLONNES_HORS_SIG.indexOf(c) === -1;
    });
  }

  function filiere(id) {
    return FILIERES.filter(function (f) { return f.id === id; })[0] || null;
  }

  /**
   * Champs saisis pour une filière, dans l'ordre d'affichage et du fichier.
   * `champs` d'une filière : ses rares champs propres, entre cascade et note.
   */
  function champsDe(id) {
    var f = filiere(id);
    return f ? CHAMPS_CASCADE.concat(f.champs || []).concat([CHAMP_OBSERVATIONS]) : [];
  }

  var CONFIG_DEFAUT = {
    operateur: '',
    collectivite: '',
    precisionMax: 20,
    hautePrecision: true,
    timeoutGps: 20,
    dureeAffinage: 30,
    afficherLambert: true,
    fondCarte: 'photo',
    // Liste vide = fonds gratuits par défaut de carte.js. Remplie, elle les remplace.
    fondsCarte: [],
    separateur: ';',
    // Clair par défaut : c'est le seul lisible en plein soleil. 'sombre' ou 'auto'
    // (selon le réglage de l'appareil) se choisissent dans Configuration.
    theme: 'clair'
  };

  global.GromaConfig = {
    FILIERES: FILIERES,
    COLONNES_TECHNIQUES: COLONNES_TECHNIQUES,
    DECIMALES: DECIMALES,
    CONFIG_DEFAUT: CONFIG_DEFAUT,
    colonnesFiliere: colonnesFiliere,
    colonnesSig: colonnesSig,
    filiere: filiere,
    champsDe: champsDe
  };
})(window);
