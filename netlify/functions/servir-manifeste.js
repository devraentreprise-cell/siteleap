// ==========================================
// Fichier : servir-manifeste.js
// Sert le manifeste d'un projet à partir de son identifiant à la racine
// Appel : /.netlify/functions/servir-manifeste?id=IDENTIFIANT_DU_PROJET
//
// Ne renvoie JAMAIS start_url ni scope : le navigateur utilise alors
// les valeurs par défaut (URL du document qui a chargé le manifeste).
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

// Durée de conservation dans le CDN (en secondes). 86400 = 24 heures
const DUREE_CACHE_SEC = 86400;

// Limites de blocage déduit : plus de 50 installations ET plus de 30 jours après création
const SEUIL_INSTALLS = 50;
const DUREE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

// Champs autorisés dans le manifeste renvoyé.
// ATTENTION : start_url et scope sont volontairement exclus.
const CHAMPS_AUTORISES = [
    "name", "short_name", "description", "id",
    "display", "display_override", "orientation",
    "background_color", "theme_color",
    "lang", "dir", "categories", "icons"
];

const ENTETES_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS"
};

function reponseJson(statusCode, payload, cacheSec = 0) {
    const headers = Object.assign({}, ENTETES_CORS, {
        "Content-Type": "application/json; charset=utf-8"
    });

    if (cacheSec > 0) {
        headers["Cache-Control"] = "public, max-age=3600";
        headers["Netlify-CDN-Cache-Control"] = "public, max-age=" + cacheSec;
    } else {
        headers["Cache-Control"] = "no-store";
    }

    return {
        statusCode: statusCode,
        headers: headers,
        body: JSON.stringify(payload)
    };
}

function estProjetBloque(creeLe, installsTotal, maintenantMs) {
    const installs = Number(installsTotal) || 0;
    const dateCreation = Number(creeLe) || 0;

    if (installs <= SEUIL_INSTALLS) {
        return false;
    }
    if (!dateCreation) {
        return false;
    }
    return maintenantMs > (dateCreation + DUREE_GRACE_MS);
}

function preparerManifeste(brut) {
    const resultat = {};
    CHAMPS_AUTORISES.forEach(function (champ) {
        if (brut[champ] !== undefined && brut[champ] !== null) {
            resultat[champ] = brut[champ];
        }
    });

    if (Array.isArray(resultat.icons)) {
        resultat.icons = resultat.icons
            .filter(function (ic) { return ic && typeof ic === "object" && typeof ic.src === "string"; })
            .map(function (ic) {
                const icone = { src: ic.src };
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
        return reponseJson(405, { success: false, message: "Méthode non autorisée." });
    }

    try {
        const params = event.queryStringParameters || {};
        const idProjet = params.id;

        if (typeof idProjet !== "string" || !FORMAT_ID_PROJET.test(idProjet)) {
            return reponseJson(400, { success: false, message: "Identifiant de projet invalide." });
        }

        // Lecture directe uniquement sur le chemin <idProjet>
        const [snapCreeLe, snapInstalls, snapManifeste] = await Promise.all([
            db.ref(idProjet + "/creeLe").once("value"),
            db.ref(idProjet + "/installs_total").once("value"),
            db.ref(idProjet + "/manifeste").once("value")
        ]);

        const brutManifeste = snapManifeste.val();
        if (!brutManifeste || typeof brutManifeste !== "object" || Array.isArray(brutManifeste)) {
            return reponseJson(404, { success: false, message: "Manifeste indisponible." }, DUREE_CACHE_SEC);
        }

        const creeLe = snapCreeLe.val();
        const installsTotal = snapInstalls.val();

        if (estProjetBloque(creeLe, installsTotal, Date.now())) {
            return reponseJson(403, { success: false, message: "Manifeste indisponible." }, DUREE_CACHE_SEC);
        }

        const manifeste = preparerManifeste(brutManifeste);

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
        return reponseJson(500, { success: false, message: "Erreur technique." });
    }
}
