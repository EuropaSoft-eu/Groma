/**
 * Réserve de tuiles pour travailler sans réseau dans le village en cours.
 *
 * On charge à l'utilisation, pas à l'avance : autour du centre de la carte, un
 * grand cercle (1 km, zooms 14 à 17) pour se repérer et un petit (300 m, zooms
 * 18 et plus) pour recaler le viseur sur un tampon. Les cercles suivent la
 * carte, donc le GPS comme les gestes de l'agent : faire glisser la carte au
 * bout d'une rue longue la charge aussi.
 *
 * Une tuile qui n'a pas servi depuis sept jours est oubliée : on travaille un
 * village à la fois, et une réserve courte garde des images récentes. Le
 * plafond de 200 Mo n'est qu'une sécurité.
 *
 * Partage des rôles : cette page télécharge, range et purge ; le service
 * worker ne fait que servir ce qui est rangé, il n'écrit jamais.
 *
 * Les tuiles sont demandées en CORS, jamais en `no-cors` : une réponse opaque
 * ne dit pas sa taille, et Chrome la compte pour plusieurs mégaoctets dans le
 * quota. La Géoplateforme répond `access-control-allow-origin: *` (vérifié le
 * 17/11/2026) ; un fond personnalisé sans CORS n'est simplement pas gardé.
 */
(function (global) {
  'use strict';

  var CACHE = 'groma-tuiles';
  var BASE = 'groma-tuiles';
  var MAGASIN = 'tuiles';

  var GRAND = { rayonM: 1000, zMin: 14, zMax: 17 };
  var PETIT = { rayonM: 300, zMin: 18 };
  // Un déplacement plus court ne fait sortir du petit cercle que sa bordure.
  var PAS_M = 150;
  var DUREE_MS = 7 * 24 * 3600 * 1000;
  var PLAFOND_OCTETS = 200 * 1024 * 1024;
  var SIMULTANES = 4;
  var JOUR_MS = 24 * 3600 * 1000;

  var TUILE = 256;
  var CIRCONFERENCE = 40075016.686;

  var base = null;          // promesse de la base IndexedDB
  var connues = null;       // url → { taille, date }, chargé une fois
  var file = [];
  var enCours = 0;
  var dernier = null;       // { url du fond, latitude, longitude }
  var horsLigne = false;

  function disponible() {
    return !!(global.caches && global.indexedDB && global.fetch && global.isSecureContext);
  }

  // --- IndexedDB ------------------------------------------------------------

  function ouvrirBase() {
    if (base) return base;
    base = new Promise(function (ok, ko) {
      var req = global.indexedDB.open(BASE, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(MAGASIN, { keyPath: 'url' }); };
      req.onsuccess = function () { ok(req.result); };
      req.onerror = function () { ko(req.error); };
    });
    return base;
  }

  function transaction(mode, travail) {
    return ouvrirBase().then(function (db) {
      return new Promise(function (ok, ko) {
        var tx = db.transaction(MAGASIN, mode);
        var resultat = travail(tx.objectStore(MAGASIN));
        tx.oncomplete = function () { ok(resultat); };
        tx.onerror = function () { ko(tx.error); };
        tx.onabort = function () { ko(tx.error); };
      });
    });
  }

  function chargerConnues() {
    if (connues) return Promise.resolve(connues);
    return transaction('readonly', function (st) {
      var liste = [];
      st.openCursor().onsuccess = function (ev) {
        var c = ev.target.result;
        if (!c) return;
        liste.push(c.value);
        c.continue();
      };
      return liste;
    }).then(function (liste) {
      connues = {};
      liste.forEach(function (t) { connues[t.url] = { taille: t.taille, date: t.date }; });
      return connues;
    });
  }

  function enregistrer(entrees) {
    if (!entrees.length) return Promise.resolve();
    return transaction('readwrite', function (st) {
      entrees.forEach(function (e) { st.put(e); });
    });
  }

  // --- Géométrie ------------------------------------------------------------

  function tailleMonde(z) { return Math.pow(2, z) * TUILE; }

  function versPixel(lat, lon, z) {
    var borne = Math.max(-85.05112878, Math.min(85.05112878, lat));
    var s = Math.sin(borne * Math.PI / 180);
    return {
      x: (lon + 180) / 360 * tailleMonde(z),
      y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * tailleMonde(z)
    };
  }

  /** Tuiles d'un niveau qui touchent le disque, et pas seulement son carré englobant. */
  function tuilesDuCercle(lat, lon, rayonM, z, url) {
    var c = versPixel(lat, lon, z);
    var r = rayonM / (CIRCONFERENCE * Math.cos(lat * Math.PI / 180) / tailleMonde(z));
    var max = Math.pow(2, z);
    var sortie = [];
    for (var ty = Math.floor((c.y - r) / TUILE); ty <= Math.floor((c.y + r) / TUILE); ty++) {
      if (ty < 0 || ty >= max) continue;
      for (var tx = Math.floor((c.x - r) / TUILE); tx <= Math.floor((c.x + r) / TUILE); tx++) {
        var px = Math.max(tx * TUILE, Math.min(c.x, (tx + 1) * TUILE));
        var py = Math.max(ty * TUILE, Math.min(c.y, (ty + 1) * TUILE));
        if ((px - c.x) * (px - c.x) + (py - c.y) * (py - c.y) > r * r) continue;
        var wx = ((tx % max) + max) % max;
        // Même construction que carte.js : le service worker retrouve la tuile
        // à l'URL exacte que l'image demandera.
        sortie.push(url.replace('{z}', z).replace('{x}', wx).replace('{y}', ty));
      }
    }
    return sortie;
  }

  function urlsAutour(fond, lat, lon) {
    var urls = [];
    var z;
    for (z = GRAND.zMin; z <= Math.min(GRAND.zMax, fond.zoomMax); z++) {
      urls = urls.concat(tuilesDuCercle(lat, lon, GRAND.rayonM, z, fond.url));
    }
    for (z = PETIT.zMin; z <= fond.zoomMax; z++) {
      urls = urls.concat(tuilesDuCercle(lat, lon, PETIT.rayonM, z, fond.url));
    }
    return urls;
  }

  function distanceM(a, b) {
    var dy = (a.latitude - b.latitude) * 110540;
    var dx = (a.longitude - b.longitude) * 111320 * Math.cos(b.latitude * Math.PI / 180);
    return Math.sqrt(dx * dx + dy * dy);
  }

  // --- Téléchargement -------------------------------------------------------

  function telecharger(url) {
    return global.fetch(url, { mode: 'cors', credentials: 'omit' }).then(function (rep) {
      var type = rep.headers.get('content-type') || '';
      // Un 404 de la Géoplateforme arrive en XML : le ranger servirait une
      // erreur pour une image pendant sept jours.
      if (!rep.ok || type.indexOf('image/') !== 0) return null;
      return rep.blob().then(function (blob) {
        var copie = new Response(blob, { headers: { 'content-type': type } });
        return global.caches.open(CACHE).then(function (cache) {
          return cache.put(url, copie);
        }).then(function () { return { url: url, taille: blob.size, date: Date.now() }; });
      });
    });
  }

  function pomper() {
    while (enCours < SIMULTANES && file.length && !horsLigne) {
      lancer(file.shift());
    }
    if (!enCours && !file.length) purger();
  }

  function lancer(url) {
    enCours++;
    telecharger(url).then(function (entree) {
      if (!entree) return null;
      connues[url] = { taille: entree.taille, date: entree.date };
      return enregistrer([entree]);
    }, function () {
      // Échec réseau : inutile de vider la file contre un mur. La prochaine
      // demande, au prochain déplacement, réessaiera.
      horsLigne = true;
      file = [];
    }).catch(function () { /* quota plein ou base indisponible : la carte reste en ligne */ })
      .then(function () { enCours--; pomper(); });
  }

  /**
   * À appeler à chaque changement de vue. Ne fait rien tant que le centre n'a
   * pas bougé de PAS_M sur le même fond.
   *
   * @param {{url:string, zoomMax:number}} fond
   * @param {{latitude:number, longitude:number}} centre
   */
  function autour(fond, centre) {
    if (!disponible() || !fond || !fond.url || !centre) return Promise.resolve(0);
    if (!centre.latitude && !centre.longitude) return Promise.resolve(0); // carte pas encore placée
    if (dernier && dernier.url === fond.url && distanceM(dernier, centre) < PAS_M) {
      return Promise.resolve(0);
    }
    dernier = { url: fond.url, latitude: centre.latitude, longitude: centre.longitude };
    horsLigne = false;

    return chargerConnues().then(function () {
      var maintenant = Date.now();
      var touchees = [];
      var deja = {};
      file.forEach(function (u) { deja[u] = true; });

      urlsAutour(fond, centre.latitude, centre.longitude).forEach(function (u) {
        var t = connues[u];
        if (t) {
          // Une tuile du village en cours repart pour sept jours. Au jour près :
          // inutile de réécrire la base à chaque glissement de carte.
          if (maintenant - t.date > JOUR_MS) {
            t.date = maintenant;
            touchees.push({ url: u, taille: t.taille, date: maintenant });
          }
        } else if (!deja[u]) {
          deja[u] = true;
          file.push(u);
        }
      });
      pomper();
      return enregistrer(touchees).then(function () { return file.length; });
    }).catch(function () { return 0; });
  }

  // --- Purge ----------------------------------------------------------------

  function supprimer(urls) {
    if (!urls.length) return Promise.resolve();
    urls.forEach(function (u) { delete connues[u]; });
    return global.caches.open(CACHE).then(function (cache) {
      return Promise.all(urls.map(function (u) { return cache.delete(u); }));
    }).then(function () {
      return transaction('readwrite', function (st) {
        urls.forEach(function (u) { st.delete(u); });
      });
    });
  }

  /** Oublie ce qui n'a pas servi depuis sept jours, puis le plus ancien au-delà du plafond. */
  function purger() {
    if (!disponible()) return Promise.resolve();
    return chargerConnues().then(function () {
      var limite = Date.now() - DUREE_MS;
      var liste = Object.keys(connues).map(function (u) {
        return { url: u, taille: connues[u].taille, date: connues[u].date };
      });
      var perimees = liste.filter(function (t) { return t.date < limite; }).map(function (t) { return t.url; });

      var restantes = liste.filter(function (t) { return t.date >= limite; })
        .sort(function (a, b) { return a.date - b.date; });
      var total = restantes.reduce(function (s, t) { return s + t.taille; }, 0);
      var i = 0;
      while (total > PLAFOND_OCTETS && i < restantes.length) {
        total -= restantes[i].taille;
        perimees.push(restantes[i].url);
        i++;
      }
      return supprimer(perimees);
    }).catch(function () { /* rien à purger si la base est inaccessible */ });
  }

  function bilan() {
    if (!disponible()) return Promise.resolve(null);
    return chargerConnues().then(function () {
      var urls = Object.keys(connues);
      return {
        tuiles: urls.length,
        octets: urls.reduce(function (s, u) { return s + connues[u].taille; }, 0),
        enAttente: file.length + enCours
      };
    }).catch(function () { return null; });
  }

  global.GromaTuiles = {
    CACHE: CACHE,
    disponible: disponible,
    autour: autour,
    purger: purger,
    bilan: bilan,
    urlsAutour: urlsAutour
  };
})(window);
