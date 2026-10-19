// ==========================================
// Fichier : activer-projet.js
// Vérifie le paiement Selar puis active le projet (30 jours)
// Remplace verifier-paiement.js
// ==========================================

import admin from "firebase-admin";

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_SECRET)),
        databaseURL: process.env.FIREBASE_DB_URL
    });
}

const db = admin.database();

const DUREE_ACTIF_JOURS = 30;
const MS_PAR_JOUR = 24 * 60 * 60 * 1000;
const CARACTERES_INTERDITS_FIREBASE = /[.#$\[\]\/]/;

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
        const idProjet = body.idProjet;
        const referenceSelar = body.referenceSelar;

        if (!jeton || typeof jeton !== "string") {
            return reponse(401, { success: false, message: "Connexion Google manquante." });
        }
        if (typeof idProjet !== "string" || !idProjet || CARACTERES_INTERDITS_FIREBASE.test(idProjet)) {
            return reponse(400, { success: false, message: "Projet invalide." });
        }
        if (typeof referenceSelar !== "string" || !referenceSelar.trim() || CARACTERES_INTERDITS_FIREBASE.test(referenceSelar)) {
            return reponse(400, { success: false, message: "Numéro de référence manquant ou invalide." });
        }

        // 2. Vérification du jeton Google : l'email vient du jeton, jamais du site
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

        // Nom du tiroir : identique à creer-projet.js et lister-projets.js
        const cleEmail = email.trim().toLowerCase().replace(/\./g, ",").replace(/[#$\[\]\/]/g, "_");

        // 3. Le projet existe-t-il bien dans le tiroir de ce client ?
        const cheminProjet = "projets/" + cleEmail + "/" + idProjet;
        const snapProjet = await db.ref(cheminProjet).once("value");
        if (!snapProjet.exists()) {
            return reponse(404, { success: false, message: "Projet introuvable." });
        }

        // 4. La référence a-t-elle déjà servi ?
        const reference = referenceSelar.trim();
        const snapReference = await db.ref("references/" + reference).once("value");
        if (snapReference.exists()) {
            console.warn("[Alerte Sécurité] Tentative de réutilisation de la référence : " + reference);
            return reponse(200, {
                success: true,
                verified: false,
                message: "Cette référence de paiement a déjà été utilisée."
            });
        }

        // 5. Interrogation de l'API Selar
        const SELAR_API_KEY = process.env.SELAR_API_KEY;
        if (!SELAR_API_KEY) {
            console.error("[Selar] Variable SELAR_API_KEY absente.");
            return reponse(500, { success: false, message: "Erreur technique lors de la vérification du paiement." });
        }

        const responseAPI = await fetch("https://api.selar.com/v1/orders/" + encodeURIComponent(reference), {
            method: "GET",
            headers: {
                "Authorization": "Bearer " + SELAR_API_KEY,
                "Content-Type": "application/json"
            }
        });

        const texteAPI = await responseAPI.text();
        console.log("[Selar] Code HTTP :", responseAPI.status);
        console.log("[Selar] Réponse :", texteAPI);

        let paymentData = {};
        try { paymentData = JSON.parse(texteAPI); } catch (e) {}

        // 6. Analyse du statut de paiement
        const isPaid = responseAPI.ok && (
            paymentData.status === "paid" ||
            paymentData.status === "success" ||
            (paymentData.data && paymentData.data.status === "paid")
        );

        if (!isPaid) {
            return reponse(200, { success: true, verified: false });
        }

        // 7. Paiement confirmé : référence payée + activation, en une seule opération
        const maintenant = Date.now();
        const miseAJour = {};

        miseAJour["references/" + reference] = true;
        miseAJour[cheminProjet + "/statut"] = "actif";
        miseAJour[cheminProjet + "/creeLe"] = maintenant;
        miseAJour[cheminProjet + "/dateFin"] = maintenant + (DUREE_ACTIF_JOURS * MS_PAR_JOUR);

        await db.ref().update(miseAJour);
        console.log("[Succès] Projet activé : " + idProjet);

        return reponse(200, { success: true, verified: true });

    } catch (error) {
        console.error("Erreur technique dans activer-projet :", error);
        return reponse(500, { success: false, message: "Erreur technique lors de l'activation du projet." });
    }
}
