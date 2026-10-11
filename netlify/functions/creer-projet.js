// ==========================================
// Fichier : creer-projet.js
// Crée un projet « en_attente » (sans paiement)
// ==========================================

import admin from "firebase-admin";
import { randomUUID, createHash } from "crypto";

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_SECRET)),
        databaseURL: process.env.FIREBASE_DB_URL
    });
}

const db = admin.database();

const FORMULES_VALIDES = ["decouverte", "pro", "pro-plus"];
const LIMITE_EN_ATTENTE = 4;
const TAILLE_MAX_MANIFESTE = 100000;
const TAILLE_MAX_IMAGE_OCTETS = 2 * 1024 * 1024;
const FORMAT_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/;

function reponse(statusCode, objet) {
    return { statusCode: statusCode, body: JSON.stringify(objet) };
}

// Envoie l'image à Cloudinary (envoi signé) et renvoie son URL, ou null en cas d'échec
async function envoyerImage(image) {
    const timestamp = Math.floor(Date.now() / 1000);
    const dossier = "icones";
    const signature = createHash("sha1")
        .update("folder=" + dossier + "&timestamp=" + timestamp + process.env.CLOUDINARY_API_SECRET)
        .digest("hex");

    const formulaire = new FormData();
    formulaire.append("file", image);
    formulaire.append("api_key", process.env.CLOUDINARY_API_KEY);
    formulaire.append("timestamp", String(timestamp));
    formulaire.append("folder", dossier);
    formulaire.append("signature", signature);

    const rep = await fetch(
        "https://api.cloudinary.com/v1_1/" + process.env.CLOUDINARY_CLOUD_NAME + "/image/upload",
        { method: "POST", body: formulaire }
    );
    const donnees = await rep.json();

    if (!rep.ok || !donnees.secure_url) {
        console.error("[Cloudinary] Échec, code :", rep.status, donnees && donnees.error ? donnees.error.message : "");
        return null;
    }
    return donnees.secure_url;
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
        const manifeste = body.manifeste;
        const projet = body.projet || {};
        const formule = projet.formule;
        const image = projet.image;

        if (!jeton || typeof jeton !== "string") {
            return reponse(401, { success: false, message: "Connexion Google manquante." });
        }
        if (!manifeste || typeof manifeste !== "object" || Array.isArray(manifeste)) {
            return reponse(400, { success: false, message: "Manifeste manquant." });
        }
        if (typeof manifeste.name !== "string" || !manifeste.name.trim()) {
            return reponse(400, { success: false, message: "Le nom du projet est manquant." });
        }
        if (JSON.stringify(manifeste).length > TAILLE_MAX_MANIFESTE) {
            return reponse(400, { success: false, message: "Manifeste trop volumineux." });
        }
        if (!FORMULES_VALIDES.includes(formule)) {
            return reponse(400, { success: false, message: "Formule invalide." });
        }
        if (typeof image !== "string" || !image) {
            return reponse(400, { success: false, message: "L'icône du projet est manquante." });
        }
        if (image.length > (TAILLE_MAX_IMAGE_OCTETS * 4 / 3) + 200 || !FORMAT_IMAGE.test(image)) {
            return reponse(400, { success: false, message: "L'icône doit être une image PNG, JPEG ou WebP de moins de 2 Mo." });
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

        // Nom du tiroir : Firebase refuse . # $ [ ] / dans un nom
        const cleEmail = email.trim().toLowerCase().replace(/\./g, ",").replace(/[#$\[\]\/]/g, "_");

        // 3. Limite : nombre de projets « en_attente » de cet email
        const snapEmail = await db.ref("projets/" + cleEmail).once("value");
        let enAttente = 0;
        if (snapEmail.exists()) {
            snapEmail.forEach(function (enfant) {
                const p = enfant.val();
                if (p && p.statut === "en_attente") enAttente++;
            });
        }
        if (enAttente >= LIMITE_EN_ATTENTE) {
            return reponse(403, {
                success: false,
                message: "Vous avez atteint la limite de " + LIMITE_EN_ATTENTE + " projets en attente de paiement."
            });
        }

        // 4. Envoi de l'icône à Cloudinary (seulement si la limite n'est pas atteinte)
        const imageUrl = await envoyerImage(image);
        if (!imageUrl) {
            return reponse(502, { success: false, message: "L'envoi de l'icône a échoué. Réessayez." });
        }

        // 5. Identifiant unique du projet
        const id = randomUUID();

        // 6. Enregistrement en une seule opération (tout ou rien)
        const miseAJour = {};

        miseAJour["projets/" + cleEmail + "/" + id] = {
            nom: manifeste.name.trim(),
            formule: formule,
            statut: "en_attente",
            creeLe: admin.database.ServerValue.TIMESTAMP,
            imageUrl: imageUrl
        };

        miseAJour["manifestes/" + id] = manifeste;

        miseAJour["stats/" + id] = {
            installs_total: 0,
            installs_pc: 0,
            installs_ios: 0,
            installs_android: 0,
            lancements_navigateur: 0,
            lancements_accueil: 0,
            duree_navigateur_total_sec: 0,
            duree_accueil_total_sec: 0
        };

        await db.ref().update(miseAJour);
        console.log("[Succès] Projet créé : " + id);

        // 7. Réponse au site
        return reponse(200, { success: true, id: id });

    } catch (error) {
        console.error("Erreur technique dans creer-projet :", error);
        return reponse(500, { success: false, message: "Erreur technique lors de la création du projet." });
    }
}
