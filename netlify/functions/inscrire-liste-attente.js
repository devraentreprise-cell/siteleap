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
        const check_only = body.check_only || false;

        // 2. Vérification du jeton (obligatoire dans tous les cas)
        if (!jeton || typeof jeton !== "string") {
            return reponse(401, { success: false, message: "Connexion manquante." });
        }

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

        // 3. Vérifier si l'utilisateur existe déjà dans la base
        const snapshot = await db.ref("liste_attente/" + cleEmail).once("value");
        const dejaInscrit = snapshot.exists();

        // 4. Si c'est juste une vérification (appelée par le front au clic sur "Finaliser")
        if (check_only) {
            return reponse(200, { success: true, already_exists: dejaInscrit });
        }

        // 5. Si c'est une inscription, on valide les autres champs
        if (!pseudo || typeof pseudo !== "string" || !pseudo.trim()) {
            return reponse(400, { success: false, message: "Le prénom ou pseudo est manquant." });
        }
        if (!whatsapp || typeof whatsapp !== "string" || !whatsapp.trim()) {
            return reponse(400, { success: false, message: "Le numéro WhatsApp est manquant." });
        }

        // 6. Si l'utilisateur est déjà inscrit, on ne réécrit pas (pour ne pas écraser ses données)
        if (dejaInscrit) {
            return reponse(200, { success: true, already_exists: true });
        }

        // 7. Enregistrement dans la Realtime Database (nouvel inscrit)
        await db.ref("liste_attente/" + cleEmail).set({
            pseudo: pseudo.trim(),
            whatsapp: whatsapp.trim(),
            date_inscription: admin.database.ServerValue.TIMESTAMP
        });

        console.log("[Succès] Nouvelle inscription liste d'attente : " + cleEmail);

        // 8. Réponse au site pour déclencher le message de succès et la redirection
        return reponse(200, { success: true, already_exists: false });

    } catch (error) {
        console.error("Erreur technique dans inscrire-liste-attente :", error);
        return reponse(500, { success: false, message: "Erreur technique lors de l'inscription." });
    }
}
