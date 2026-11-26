// ==========================================
// Fichier : verifier-reference.js
// Vérifie qu'une référence de paiement n'a pas
// déjà été utilisée, puis l'enregistre dans
// « numeros_de_reference » (Firebase RTDB)
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

function nettoyerCleFirebase(valeur) {
    return String(valeur).trim().replace(/[.#$\[\]\/]/g, "_");
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
        const referenceBrute = body.reference || body.referenceTransaction;
        const projetId = body.projetId;

        if (!jeton || typeof jeton !== "string") {
            return reponse(401, { success: false, message: "Connexion Google manquante." });
        }

        if (typeof referenceBrute !== "string" || !referenceBrute.trim()) {
            return reponse(400, {
                success: false,
                message: "Veuillez saisir le numéro de référence reçu par e-mail."
            });
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

        const referenceNettoyee = referenceBrute.trim();
        const cleReference = nettoyerCleFirebase(referenceNettoyee.toLowerCase());

        if (!cleReference) {
            return reponse(400, { success: false, message: "Numéro de référence invalide." });
        }

        const refRacine = db.ref("numeros_de_reference");
        const snapRacine = await refRacine.once("value");

        // Si le nœud « numeros_de_reference » n'existe pas encore, on le crée puis on ajoute la référence
        if (!snapRacine.exists()) {
            await refRacine.set({
                [cleReference]: {
                    reference: referenceNettoyee,
                    email: email.trim().toLowerCase(),
                    projetId: projetId ? String(projetId) : null,
                    enregistreeLe: admin.database.ServerValue.TIMESTAMP
                }
            });
            return reponse(200, {
                success: true,
                dejaUtilisee: false,
                reference: referenceNettoyee
            });
        }

        // Vérification : la référence figure-t-elle déjà dans « numeros_de_reference » ?
        let dejaPresente = false;
        snapRacine.forEach(function (enfant) {
            const val = enfant.val();
            const cleEnfant = String(enfant.key || "").toLowerCase();
            const refEnfant = val && typeof val.reference === "string"
                ? val.reference.trim().toLowerCase()
                : "";

            if (cleEnfant === cleReference || refEnfant === referenceNettoyee.toLowerCase()) {
                dejaPresente = true;
                return true;
            }
        });

        if (dejaPresente) {
            return reponse(409, {
                success: false,
                dejaUtilisee: true,
                message: "Ce numéro de référence a été utilisé pour un autre projet."
            });
        }

        // La référence n'existe pas encore : on l'ajoute dans « numeros_de_reference »
        await refRacine.child(cleReference).set({
            reference: referenceNettoyee,
            email: email.trim().toLowerCase(),
            projetId: projetId ? String(projetId) : null,
            enregistreeLe: admin.database.ServerValue.TIMESTAMP
        });

        return reponse(200, {
            success: true,
            dejaUtilisee: false,
            reference: referenceNettoyee
        });

    } catch (error) {
        console.error("Erreur technique dans verifier-reference :", error);
        return reponse(500, {
            success: false,
            message: "Erreur technique lors de la vérification de la référence."
        });
    }
}
