// ==========================================
// Fichier : enregistrer-stat.js
// Reçoit un événement d'installation et met à jour les stats sous <idProjet>
// Appel : POST /.netlify/functions/enregistrer-stat
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

const ENTETES_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function reponseJson(statusCode, payload) {
    return {
        statusCode: statusCode,
        headers: Object.assign({}, ENTETES_CORS, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
        }),
        body: JSON.stringify(payload)
    };
}

function obtenirJourUtc(maintenant = new Date()) {
    const annee = maintenant.getUTCFullYear();
    const mois = String(maintenant.getUTCMonth() + 1).padStart(2, "0");
    const jour = String(maintenant.getUTCDate()).padStart(2, "0");
    return `${annee}-${mois}-${jour}`;
}

function detecterOs(userAgent = "", osFourni = "") {
    const propre = String(osFourni || "").toLowerCase().trim();
    if (propre === "android" || propre === "ios" || propre === "pc") {
        return propre;
    }

    const ua = String(userAgent || "").toLowerCase();
    if (/android/.test(ua)) {
        return "android";
    }
    if (/iphone|ipad|ipod/.test(ua)) {
        return "ios";
    }
    return "pc";
}

function detecterPays(headers = {}, paysFourni = "") {
    if (typeof paysFourni === "string" && /^[A-Za-z]{2}$/.test(paysFourni.trim())) {
        return paysFourni.trim().toUpperCase();
    }

    const candidats = [
        headers["x-country"],
        headers["x-nf-country"],
        headers["cf-ipcountry"]
    ];

    for (const val of candidats) {
        if (typeof val === "string" && /^[A-Za-z]{2}$/.test(val.trim())) {
            return val.trim().toUpperCase();
        }
    }

    return "XX";
}

function incrementer(ref) {
    return ref.transaction(function (courant) {
        return (Number(courant) || 0) + 1;
    });
}

export async function handler(event, context) {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers: ENTETES_CORS, body: "" };
    }
    if (event.httpMethod !== "POST") {
        return reponseJson(405, { success: false, message: "Méthode non autorisée." });
    }

    try {
        let corps = {};
        if (event.body) {
            try {
                corps = JSON.parse(event.body);
            } catch (e) {
                return reponseJson(400, { success: false, message: "Corps JSON invalide." });
            }
        }

        const idProjet = corps.id;
        if (typeof idProjet !== "string" || !FORMAT_ID_PROJET.test(idProjet)) {
            return reponseJson(400, { success: false, message: "Identifiant de projet invalide." });
        }

        // Vérifie que le projet existe bien à la racine avant d'écrire
        const snapProjet = await db.ref(idProjet + "/creeLe").once("value");
        if (snapProjet.val() === null) {
            return reponseJson(404, { success: false, message: "Projet introuvable." });
        }

        const headers = event.headers || {};
        const userAgent = headers["user-agent"] || headers["User-Agent"] || "";
        const os = detecterOs(userAgent, corps.os);
        const pays = detecterPays(headers, corps.pays);
        const jour = obtenirJourUtc();

        const baseProjet = db.ref(idProjet);

        await Promise.all([
            incrementer(baseProjet.child("installs_total")),
            incrementer(baseProjet.child("stats/installs_total")),
            incrementer(baseProjet.child("stats/installs_par_jour/" + jour)),
            incrementer(baseProjet.child("stats/os/" + os)),
            incrementer(baseProjet.child("stats/pays/" + pays))
        ]);

        return reponseJson(200, {
            success: true,
            id: idProjet,
            os: os,
            pays: pays,
            jour: jour
        });

    } catch (error) {
        console.error("Erreur technique dans enregistrer-stat :", error);
        return reponseJson(500, { success: false, message: "Erreur technique." });
    }
}
