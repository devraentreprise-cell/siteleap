// ==========================================
// Fichier : lister-projets.js
// Lit les projets sous <cleEmail> et déduit "suspendu" à partir de
// creeLe et installs_total.
// Le statut renvoyé est TOUJOURS cohérent : si suspendu est déduit,
// seul "suspendu" ressort, aucun autre statut.
// ==========================================

import admin from "firebase-admin";

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_SECRET)),
        databaseURL: process.env.FIREBASE_DB_URL
    });
}

const db = admin.database();

const SEUIL_INSTALLS = 50;
const DUREE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

function reponse(statusCode, objet) {
    return {
        statusCode: statusCode,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(objet)
    };
}

function estSuspendu(creeLe, installsTotal, maintenantMs) {
    const installs = Number(installsTotal) || 0;
    const dateCreation = Number(creeLe) || 0;
    if (installs <= SEUIL_INSTALLS || !dateCreation) {
        return false;
    }
    return maintenantMs > (dateCreation + DUREE_GRACE_MS);
}

export async function handler(event, context) {
    if (event.httpMethod !== "POST") {
        return reponse(405, { success: false, message: "Méthode non autorisée." });
    }

    try {
        let body;
        try {
            body = JSON.parse(event.body || "{}");
        } catch (e) {
            return reponse(400, { success: false, message: "Données illisibles." });
        }

        const jeton = body.jeton;
        if (!jeton || typeof jeton !== "string") {
            return reponse(401, { success: false, message: "Connexion Google manquante." });
        }

        let email;
        try {
            const decode = await admin.auth().verifyIdToken(jeton);
            email = decode.email;
        } catch (e) {
            return reponse(401, { success: false, message: "Connexion Google invalide. Reconnectez-vous." });
        }
        if (!email) {
            return reponse(401, { success: false, message: "Adresse email introuvable." });
        }

        const cleEmail = email.trim().toLowerCase().replace(/\./g, ",").replace(/[#$\[\]\/]/g, "_");

        // Lecture directe sous <cleEmail> + déduction du statut suspendu
        const snapProjets = await db.ref(cleEmail).once("value");

        if (!snapProjets.exists()) {
            return reponse(200, { success: true, projets: [] });
        }

        const maintenantMs = Date.now();
        const projets = [];

        snapProjets.forEach(function (enfant) {
            const p = enfant.val() || {};
            const creeLe = Number(p.creeLe) || 0;
            const installsTotal = Number(p.installs_total) || 0;
            const suspendu = estSuspendu(creeLe, installsTotal, maintenantMs);

            // Le statut "suspendu" est DÉDUIT, pas stocké en base.
            // S'il est déduit suspendu, SEUL "suspendu" ressort.
            // Sinon, on reprend le statut d'origine.
            const statut = suspendu ? "suspendu" : (p.statut || "");

            const element = {
                id: enfant.key,
                nom: p.nom || "",
                formule: p.formule || "",
                statut: statut,
                creeLe: creeLe,
                imageUrl: p.imageUrl || "",
                demande_reactivation: Boolean(p.demande_reactivation),
                reference_deblocage: p.reference_deblocage || ""
            };

            // On n'expose pas installs_total si le projet est suspendu
            if (!suspendu) {
                element.installs_total = installsTotal;
            }

            projets.push(element);
        });

        // Du plus récent au plus ancien
        projets.sort(function (a, b) {
            return b.creeLe - a.creeLe;
        });

        return reponse(200, { success: true, projets: projets });

    } catch (error) {
        console.error("Erreur technique dans lister-projets :", error);
        return reponse(500, { success: false, message: "Erreur technique lors de la lecture des projets." });
    }
}
