// ==========================================
// Fichier : servir-manifeste.js
// Sert le manifeste d'un site installable au navigateur du visiteur
// Appel : /.netlify/functions/servir-manifeste?id=IDENTIFIANT_DU_PROJET
// ==========================================

import admin from "firebase-admin";

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_SECRET)),
        databaseURL: process.env.FIREBASE_DB_URL
    });
}

const db = admin.database();

const FORMAT_ID_PROJET = /^[A-Za-z0-9-]{8,64}$/;

// Durée de conservation du manifeste dans le CDN (en secondes). 86400 = 24 heures
const DUREE_CACHE_SEC = 86400;

// Seuls ces champs standards du manifeste sont renvoyés
const CHAMPS_AUTORISES = [
    "name", "short_name", "description", "id", "start_url", "scope",
    "display", "display_override", "orientation", "background_color",
    "theme_color", "lang", "dir", "categories", "icons"
];

const ENTETES_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS"
};

function erreur(statusCode, message) {
    return {
        statusCode: statusCode,
        headers: Object.assign({}, ENTETES_CORS, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        }),
        body: JSON.stringify({ success: false, message: message })
    };
}

// Cherche le projet par son identifiant dans tous les tiroirs de « projets »
// (on ignore les emails) et renvoie son statut, ou null s'il n'existe pas
async function trouverStatutProjet(idProjet) {
    const snap = await db.ref("projets").once("value");
    let statut = null;
    let trouve = false;
    snap.forEach(function (tiroirEmail) {
        if (tiroirEmail.hasChild(idProjet)) {
            trouve = true;
            statut = tiroirEmail.child(idProjet).child("statut").val();
            return true; // arrête la recherche
        }
    });
    return trouve ? String(statut || "") : null;
}

// Accepte uniquement une adresse de site valide (ex. https://monsite.com) et renvoie son origine
function lireOrigine(valeur) {
    if (typeof valeur !== "string" || valeur.length > 200) return "";
    try {
        const u = new URL(valeur);
        if (u.protocol !== "https:" && u.protocol !== "http:") return "";
        return u.origin;
    } catch (e) {
        return "";
    }
}

// Un lien relatif d'un manifeste distant se lirait à partir du site de WebToApp.
// On le rattache donc au site du client quand celui-ci fournit son adresse.
function absolutiser(valeur, origine) {
    if (typeof valeur !== "string" || !origine) return valeur;
    if (/^(https?:|data:|blob:)/i.test(valeur)) return valeur;
    try {
        return new URL(valeur, origine + "/").href;
    } catch (e) {
        return valeur;
    }
}

// Ne garde que les champs autorisés, et rattache les liens au site du client
function preparerManifeste(brut, origine) {
    const resultat = {};
    CHAMPS_AUTORISES.forEach(function (champ) {
        if (brut[champ] !== undefined && brut[champ] !== null) {
            resultat[champ] = brut[champ];
        }
    });

    if (resultat.start_url) resultat.start_url = absolutiser(resultat.start_url, origine);
    if (resultat.scope) resultat.scope = absolutiser(resultat.scope, origine);

    if (Array.isArray(resultat.icons)) {
        resultat.icons = resultat.icons
            .filter(function (ic) { return ic && typeof ic === "object" && typeof ic.src === "string"; })
            .map(function (ic) {
                const icone = { src: absolutiser(ic.src, origine) };
                if (ic.sizes) icone.sizes = ic.sizes;
                if (ic.type) icone.type = ic.type;
                if (ic.purpose) icone.purpose = ic.purpose;
                return icone;
            });
    } else {
        delete resultat.icons;
    }

    return resultat;
}

export async function handler(event, context) {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers: ENTETES_CORS, body: "" };
    }
    if (event.httpMethod !== "GET" && event.httpMethod !== "HEAD") {
        return erreur(405, "Méthode non autorisée.");
    }

    try {
        const params = event.queryStringParameters || {};
        const idProjet = params.id;

        if (typeof idProjet !== "string" || !FORMAT_ID_PROJET.test(idProjet)) {
            return erreur(400, "Identifiant de projet invalide.");
        }

        // Le statut se lit dans la partie « projets » : seul un projet ACTIF a un manifeste
        const statut = await trouverStatutProjet(idProjet);
        if (statut !== "actif") {
            // Même réponse pour « introuvable », « en attente » et « suspendu »
            return erreur(404, "Manifeste indisponible.");
        }

        const snap = await db.ref("manifestes/" + idProjet).once("value");
        const brut = snap.val();
        if (!brut || typeof brut !== "object" || Array.isArray(brut)) {
            return erreur(404, "Manifeste indisponible.");
        }

        // Adresse du site du client (facultative), pour rattacher les liens relatifs
        const origine = lireOrigine(params.o);
        const manifeste = preparerManifeste(brut, origine);

        return {
            statusCode: 200,
            headers: Object.assign({}, ENTETES_CORS, {
                "Content-Type": "application/manifest+json; charset=utf-8",
                "Cache-Control": "public, max-age=3600",
                "Netlify-CDN-Cache-Control": "public, max-age=" + DUREE_CACHE_SEC
            }),
            body: JSON.stringify(manifeste)
        };

    } catch (error) {
        console.error("Erreur technique dans servir-manifeste :", error);
        return erreur(500, "Erreur technique.");
    }
}
