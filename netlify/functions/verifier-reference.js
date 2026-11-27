// ==========================================
// Fichier : verifier-reference.js
// Vérifie qu'une référence de paiement n'a pas déjà été utilisée,
// l'enregistre dans « numeros_de_reference », et passe à true
// le champ « demande_reactivation » du projet concerné,
// en enregistrant également la référence dans « reference_deblocage ».
//
// Structure de la base :
//   numeros_de_reference/<cleReference> = "REF-XXX"
//   <cleEmail>/<projetId>/demande_reactivation = true
//   <cleEmail>/<projetId>/reference_deblocage = "REF-XXX"
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

function nettoyerCleFirebase(valeur) {
    return String(valeur).trim().replace(/[.#$\[\]\/]/g, "_");
}

function cleEmailDe(email) {
    return String(email || "").trim().toLowerCase()
        .replace(/\./g, ",")
        .replace(/[#$\[\]\/]/g, "_");
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

        if (!projetId) {
            return reponse(400, { success: false, message: "Projet introuvable." });
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

        // 1) Vérification globale de la référence
        const refRacine = db.ref("numeros_de_reference");
        const snapRacine = await refRacine.once("value");

        if (snapRacine.exists()) {
            let dejaPresente = false;
            snapRacine.forEach(function (enfant) {
                const cleEnfant = String(enfant.key || "").toLowerCase();
                const valEnfant = enfant.val();
                const refEnfant = (typeof valEnfant === "string" ? valEnfant : "").trim().toLowerCase();

                if (cleEnfant === cleReference || refEnfant === referenceNettoyee.toLowerCase()) {
                    dejaPresente = true;
                    return true;
                }
            });

            if (dejaPresente) {
                return reponse(409, {
                    success: false,
                    dejaUtilisee: true,
                    message: "Ce numéro de référence a déjà été utilisé pour un autre projet."
                });
            }
        }

        // 2) Enregistrement de la référence (uniquement la référence)
        await refRacine.child(cleReference).set(referenceNettoyee);

        // 3) Marquage du projet : demande_reactivation = true + reference_deblocage = référence
        const cleEmail = cleEmailDe(email);
        try {
            await db.ref(cleEmail + "/" + String(projetId)).update({
                demande_reactivation: true,
                reference_deblocage: referenceNettoyee
            });
        } catch (e) {
            console.warn("Référence enregistrée mais marquage du projet échoué :", e);
        }

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
