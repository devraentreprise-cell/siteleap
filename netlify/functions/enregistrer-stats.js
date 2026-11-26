// ==========================================
// Fichier : enregistrer-stat.js
// Reçoit un événement d'installation et met à jour les stats sous <idProjet>
// Appel : POST /.netlify/functions/enregistrer-stat
//
// Aligné sur creer-projet.js et lister-projets.js :
//  - installs_par_jour : clés = noms de jours (lundi…dimanche), valeur = { installs: N }
//  - OS : installs_android / installs_ios / installs_pc (à plat dans stats)
//  - pays : stats/pays/<CODE> = { nom, lat, lng, count }
//  - installs_total : incrémenté à la fois à la racine et dans stats
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

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

// Mapping code pays -> nom + coordonnées
const PAYS_CONNUS = {
    CM: { nom: "Cameroun",      lat: 3.848,   lng: 11.502 },
    FR: { nom: "France",        lat: 46.2276, lng: 2.2137 },
    CI: { nom: "Côte d'Ivoire", lat: 7.54,    lng: -5.5471 },
    SN: { nom: "Sénégal",       lat: 14.4974, lng: -14.4524 },
    CA: { nom: "Canada",        lat: 56.1304, lng: -106.3468 },
    BE: { nom: "Belgique",      lat: 50.5039, lng: 4.4699 },
    GA: { nom: "Gabon",         lat: -0.8037, lng: 11.6094 },
    MA: { nom: "Maroc",         lat: 31.7917, lng: -7.0926 },
    US: { nom: "États-Unis",    lat: 37.0902, lng: -95.7129 },
    DE: { nom: "Allemagne",     lat: 51.1657, lng: 10.4515 },
    GB: { nom: "Royaume-Uni",   lat: 55.3781, lng: -3.4360 },
    NG: { nom: "Nigeria",       lat: 9.0820,  lng: 8.6753 },
    CG: { nom: "Congo",         lat: -4.0383, lng: 21.7587 }
};

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

// Nom du jour à l'heure du Cameroun (Africa/Douala), en français
function nomJourCameroun() {
    const dateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Douala",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
    const [an, m, j] = dateStr.split("-").map(Number);
    const jourSemaine = new Date(Date.UTC(an, m - 1, j)).getUTCDay();
    return JOURS[jourSemaine];
}

function detecterOs(userAgent = "", osFourni = "") {
    const propre = String(osFourni || "").toLowerCase().trim();
    if (propre === "android" || propre === "ios" || propre === "pc") {
        return propre;
    }
    const ua = String(userAgent || "").toLowerCase();
    if (/android/.test(ua)) return "android";
    if (/iphone|ipad|ipod/.test(ua)) return "ios";
    return "pc";
}

function detecterCodePays(headers = {}, paysFourni = "") {
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

function incrementerSimple(ref) {
    return ref.transaction(function (courant) {
        return (Number(courant) || 0) + 1;
    });
}

function incrementerJour(refJour) {
    return refJour.child("installs").transaction(function (courant) {
        return (Number(courant) || 0) + 1;
    });
}

function incrementerPays(refPays, infosPays) {
    return refPays.transaction(function (courant) {
        const base = (courant && typeof courant === "object") ? courant : {};
        return {
            nom: base.nom || infosPays.nom,
            lat: typeof base.lat === "number" ? base.lat : infosPays.lat,
            lng: typeof base.lng === "number" ? base.lng : infosPays.lng,
            count: (Number(base.count) || 0) + 1
        };
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

        const snapProjet = await db.ref(idProjet + "/creeLe").once("value");
        if (snapProjet.val() === null) {
            return reponseJson(404, { success: false, message: "Projet introuvable." });
        }

        const headers = event.headers || {};
        const userAgent = headers["user-agent"] || headers["User-Agent"] || "";
        const os = detecterOs(userAgent, corps.os);
        const codePays = detecterCodePays(headers, corps.pays);
        const infosPays = PAYS_CONNUS[codePays] || {
            nom: "Pays " + codePays,
            lat: 0,
            lng: 0
        };
        const jour = nomJourCameroun();

        const baseProjet = db.ref(idProjet);

        await Promise.all([
            incrementerSimple(baseProjet.child("installs_total")),
            incrementerSimple(baseProjet.child("stats/installs_total")),
            incrementerJour(baseProjet.child("stats/installs_par_jour/" + jour)),
            incrementerSimple(baseProjet.child("stats/installs_" + os)),
            incrementerPays(baseProjet.child("stats/pays/" + codePays), infosPays)
        ]);

        return reponseJson(200, {
            success: true,
            id: idProjet,
            os: os,
            pays: codePays,
            jour: jour
        });

    } catch (error) {
        console.error("Erreur technique dans enregistrer-stat :", error);
        return reponseJson(500, { success: false, message: "Erreur technique." });
    }
}
