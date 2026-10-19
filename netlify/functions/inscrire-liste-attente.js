// ==========================================
// Fichier : inscrire-liste-attente.js
// Enregistre un utilisateur dans la liste d'attente
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
    return { statusCode: statusCode, body: JSON.stringify(objet) };
}

export async function handler(event, context) {
    if (event.httpMethod !== "POST") {
        return reponse(405, { success: false, message: "Méthode non autorisée." });
    }

    try {
        // 1. Lecture de ce que le site envoie
        let body;
        try {
            body = JSON.parse(event.body || "{}");
        } catch (e) {
            return reponse(400, { success: false, message: "Données illisibles." });
        }

        const jeton = body.jeton;
        const pseudo = body.pseudo;
        const whatsapp = body.whatsapp;

        // 2. Vérifications de base
        if (!jeton || typeof jeton !== "string") {
            return reponse(401, { success: false, message: "Connexion manquante." });
        }
        if (!pseudo || typeof pseudo !== "string" || !pseudo.trim()) {
            return reponse(400, { success: false, message: "Le prénom ou pseudo est manquant." });
        }
        if (!whatsapp || typeof whatsapp !== "string" || !whatsapp.trim()) {
            return reponse(400, { success: false, message: "Le numéro WhatsApp est manquant." });
        }

        // 3. Vérification du jeton : l'email vient du jeton, jamais du site
        let email;
        try {
            const decode = await admin.auth().verifyIdToken(jeton);
            email = decode.email;
        } catch (e) {
            return reponse(401, { success: false, message: "Connexion invalide. Reconnectez-vous." });
        }
        if (!email) {
            return reponse(401, { success: false, message: "Adresse email introuvable." });
        }

        // Nom du tiroir : Firebase refuse . # $ [ ] / dans un nom
        const cleEmail = email.trim().toLowerCase().replace(/\./g, ",").replace(/[#$\[\]\/]/g, "_");

        // 4. Enregistrement dans la Realtime Database
        // On utilise "set" pour écraser si la personne reclique (évite les doublons)
        await db.ref("liste_attente/" + cleEmail).set({
            pseudo: pseudo.trim(),
            whatsapp: whatsapp.trim(),
            date_inscription: admin.database.ServerValue.TIMESTAMP
        });

        console.log("[Succès] Inscription liste d'attente : " + cleEmail);

        // 5. Réponse au site pour déclencher la redirection WhatsApp
        return reponse(200, { success: true });

    } catch (error) {
        console.error("Erreur technique dans inscrire-liste-attente :", error);
        return reponse(500, { success: false, message: "Erreur technique lors de l'inscription." });
    }
}
