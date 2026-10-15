// ==========================================
// Fichier : enregistrer-stats.js
// Reçoit les événements d'un site installable et met à jour ses statistiques
// Le statut du projet est lu dans la partie « projets » (jamais dans « stats »)
// ==========================================

import admin from "firebase-admin";

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_SECRET)),
        databaseURL: process.env.FIREBASE_DB_URL
    });
}

const db = admin.database();

const TAILLE_MAX_MESSAGE = 2000;
const DUREE_MAX_SESSION_SEC = 4 * 60 * 60; // une session de plus de 4 h est ignorée
const FORMAT_ID_PROJET = /^[A-Za-z0-9-]{8,64}$/;
const FORMAT_ID_APPAREIL = /^[A-Za-z0-9_-]{16,64}$/;
const MODES = ["navigateur", "accueil"];
const JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

function reponse(statusCode, objet) {
    return {
        statusCode: statusCode,
        headers: {
            "Access-Control-Allow-Origin": "*", // appelé depuis les sites hébergés chez les clients
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST, OPTIONS"
        },
        body: JSON.stringify(objet)
    };
}

// Message reçu mais non compté (projet non actif, appareil déjà compté, etc.)
function ignore() {
    return reponse(200, { success: true, ignore: true });
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

// Date du jour (AAAA-MM-JJ) et nom du jour, à l'heure du Cameroun
function obtenirInfosJourCameroun() {
    const dateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Douala",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
    const p = dateStr.split("-").map(Number);
    const jourSemaine = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); // 0 = dimanche
    return { dateDuJour: dateStr, nomJour: JOURS[(jourSemaine + 6) % 7] };
}

// L'appareil est déterminé ici, d'après le navigateur, jamais d'après ce que dit le site
function detecterPlateforme(event) {
    const ua = String((event.headers && event.headers["user-agent"]) || "");
    if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
    if (/Android/i.test(ua)) return "android";
    return "pc";
}

// Le pays est déterminé ici, d'après l'adresse du visiteur (en-tête ajouté par Netlify)
function lirePays(event) {
    try {
        const brut = event.headers && event.headers["x-nf-geo"];
        if (!brut) return null;
        const geo = JSON.parse(Buffer.from(brut, "base64").toString("utf8"));
        const code = geo && geo.country && geo.country.code;
        if (!/^[A-Z]{2}$/.test(code || "")) return null;
        return {
            code: code,
            nom: String(geo.country.name || code),
            lat: Number(geo.latitude) || 0,
            lng: Number(geo.longitude) || 0
        };
    } catch (e) {
        return null;
    }
}

export async function handler(event, context) {
    if (event.httpMethod === "OPTIONS") {
        return reponse(200, { success: true });
    }
    if (event.httpMethod !== "POST") {
        return reponse(405, { success: false, message: "Méthode non autorisée." });
    }

    try {
        // 1. Lecture et contrôle du message
        const corps = event.body || "";
        if (corps.length > TAILLE_MAX_MESSAGE) {
            return reponse(413, { success: false, message: "Message trop volumineux." });
        }

        let body;
        try {
            body = JSON.parse(corps || "{}");
        } catch (e) {
            return reponse(400, { success: false, message: "Données illisibles." });
        }

        const idProjet = body.id;
        const type = body.type; // "install", "lancement" ou "duree"
        const details = (body.details && typeof body.details === "object") ? body.details : {};

        if (typeof idProjet !== "string" || !FORMAT_ID_PROJET.test(idProjet)) {
            return reponse(400, { success: false, message: "Identifiant de projet invalide." });
        }
        if (["install", "lancement", "duree"].indexOf(type) === -1) {
            return reponse(400, { success: false, message: "Type d'événement inconnu." });
        }

        // 2. Le statut se lit dans la partie « projets » : seuls les projets ACTIFS comptent
        const statut = await trouverStatutProjet(idProjet);
        if (statut === null) {
            return reponse(404, { success: false, message: "Projet introuvable." });
        }
        if (statut !== "actif") {
            return ignore();
        }

        const refStats = db.ref("stats/" + idProjet);

        // 3. Traitement selon le type d'événement
        if (type === "install") {
            const appareil = details.appareil;
            if (typeof appareil !== "string" || !FORMAT_ID_APPAREIL.test(appareil)) {
                return reponse(400, { success: false, message: "Identifiant d'appareil invalide." });
            }

            // Une installation = une seule fois par appareil et par projet
            const refAppareil = db.ref("appareils_installes/" + idProjet + "/" + appareil);
            const resultat = await refAppareil.transaction(function (actuel) {
                if (actuel) return undefined; // déjà compté : on annule
                return { le: admin.database.ServerValue.TIMESTAMP };
            });
            if (!resultat.committed) {
                return ignore();
            }

            const plateforme = detecterPlateforme(event);
            const augmenter = admin.database.ServerValue.increment;

            // Compteurs (opérations atomiques)
            const miseAJour = { installs_total: augmenter(1) };
            miseAJour["installs_" + plateforme] = augmenter(1);
            await refStats.update(miseAJour);

            // Installations du jour (la case d'un jour de l'ancienne semaine est remise à zéro)
            const info = obtenirInfosJourCameroun();
            await refStats.child("installs_par_jour/" + info.nomJour).transaction(function (actuel) {
                if (!actuel || actuel.date !== info.dateDuJour) {
                    return { date: info.dateDuJour, installs: 1 };
                }
                return { date: actuel.date, installs: (Number(actuel.installs) || 0) + 1 };
            });

            // Pays du visiteur
            const pays = lirePays(event);
            if (pays) {
                await refStats.child("pays/" + pays.code).transaction(function (actuel) {
                    if (!actuel) {
                        return { nom: pays.nom, lat: pays.lat, lng: pays.lng, count: 1 };
                    }
                    actuel.count = (Number(actuel.count) || 0) + 1;
                    return actuel;
                });
            }

        } else if (type === "lancement") {
            const mode = details.mode;
            if (MODES.indexOf(mode) === -1) {
                return reponse(400, { success: false, message: "Mode invalide." });
            }
            const miseAJour = {};
            miseAJour["lancements_" + mode] = admin.database.ServerValue.increment(1);
            await refStats.update(miseAJour);

        } else if (type === "duree") {
            const mode = details.mode;
            const secondes = Math.floor(Number(details.secondes));
            if (MODES.indexOf(mode) === -1) {
                return reponse(400, { success: false, message: "Mode invalide." });
            }
            // Durée négative, nulle ou absurde : ignorée
            if (!Number.isFinite(secondes) || secondes <= 0 || secondes > DUREE_MAX_SESSION_SEC) {
                return ignore();
            }
            const miseAJour = {};
            miseAJour["duree_" + mode + "_total_sec"] = admin.database.ServerValue.increment(secondes);
            await refStats.update(miseAJour);
        }

        return reponse(200, { success: true });

    } catch (error) {
        console.error("Erreur technique dans enregistrer-stats :", error);
        return reponse(500, { success: false, message: "Erreur technique lors de la mise à jour des stats." });
    }
}
