// ==========================================
// Fichier : activer-projet.js
// Passe le statut d'un projet de "en_attente" à "actif".
// Ne touche à aucun autre champ (ni demande_reactivation,
// ni installs_total, ni stats).
// ==========================================

import admin from "firebase-admin";

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_SECRET)),
        databaseURL: process.env.FIREBASE_DB_URL
    });
}

const db = admin.database();

function reponse(statusCode, objet) {
    return {
        statusCode: statusCode,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(objet)
    };
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
        const projetId = body.projetId;

        if (!jeton || typeof jeton !== "string") {
            return reponse(401, { success: false, message: "Connexion Google manquante." });
        }
        if (!projetId || typeof projetId !== "string") {
            return reponse(400, { success: false, message: "Identifiant du projet manquant." });
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

        const refProjet = db.ref(cleEmail + "/" + projetId);
        const snapProjet = await refProjet.once("value");

        if (!snapProjet.exists()) {
            return reponse(404, { success: false, message: "Projet introuvable." });
        }

        await refProjet.child("statut").set("actif");

        return reponse(200, { success: true });

    } catch (error) {
        console.error("Erreur technique dans activer-projet :", error);
        return reponse(500, {
            success: false,
            message: "Erreur technique lors de l'activation du projet."
        });
    }
}
