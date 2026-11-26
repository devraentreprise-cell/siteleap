// ==========================================
// Fichier : creer-projet.js
// Crée un projet « en_attente » (limite : 1 en attente max)
// Applique les valeurs par défaut du manifeste (#ffffff, portrait, etc.)
// Écrit sous <cleEmail>/<id> et sous <id>
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
const LIMITE_EN_ATTENTE = 1;
const TAILLE_MAX_MANIFESTE = 100000;
const TAILLE_MAX_IMAGE_OCTETS = 2 * 1024 * 1024;
const FORMAT_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/;

const ICONES_PAR_DEFAUT = [
    {
        src: "icons/android/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any"
    },
    {
        src: "icons/android/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any"
    },
    {
        src: "icons/android/icon-192-maskable.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable"
    },
    {
        src: "icons/android/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable"
    }
];

function reponse(statusCode, objet) {
    return {
        statusCode: statusCode,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(objet)
    };
}

function normaliserManifeste(manifesteBrut) {
    const nomPropre = String(manifesteBrut.name || "").trim();
    return {
        ...manifesteBrut,
        name: nomPropre,
        short_name: typeof manifesteBrut.short_name === "string" && manifesteBrut.short_name.trim()
            ? manifesteBrut.short_name.trim().slice(0, 12)
            : nomPropre.slice(0, 12),
        start_url: typeof manifesteBrut.start_url === "string" && manifesteBrut.start_url.trim()
            ? manifesteBrut.start_url.trim()
            : "./",
        scope: typeof manifesteBrut.scope === "string" && manifesteBrut.scope.trim()
            ? manifesteBrut.scope.trim()
            : "/",
        display: typeof manifesteBrut.display === "string" && manifesteBrut.display.trim()
            ? manifesteBrut.display.trim()
            : "standalone",
        orientation: typeof manifesteBrut.orientation === "string" && manifesteBrut.orientation.trim()
            ? manifesteBrut.orientation.trim()
            : "portrait",
        background_color: typeof manifesteBrut.background_color === "string" && manifesteBrut.background_color.trim()
            ? manifesteBrut.background_color.trim()
            : "#ffffff",
        theme_color: typeof manifesteBrut.theme_color === "string" && manifesteBrut.theme_color.trim()
            ? manifesteBrut.theme_color.trim()
            : "#ffffff",
        icons: Array.isArray(manifesteBrut.icons) && manifesteBrut.icons.length > 0
            ? manifesteBrut.icons
            : ICONES_PAR_DEFAUT
    };
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
        const manifesteBrut = body.manifeste;
        const projet = body.projet || {};
        const formule = projet.formule;
        const image = projet.image;

        if (!jeton || typeof jeton !== "string") {
            return reponse(401, { success: false, message: "Connexion Google manquante." });
        }
        if (!manifesteBrut || typeof manifesteBrut !== "object" || Array.isArray(manifesteBrut)) {
            return reponse(400, { success: false, message: "Manifeste manquant." });
        }
        if (typeof manifesteBrut.name !== "string" || !manifesteBrut.name.trim()) {
            return reponse(400, { success: false, message: "Le nom du projet est manquant." });
        }
        if (JSON.stringify(manifesteBrut).length > TAILLE_MAX_MANIFESTE) {
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

        const manifeste = normaliserManifeste(manifesteBrut);

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

        // 3. Limite : 1 seul projet « en_attente » maximum pour cet email
        const snapEmail = await db.ref(cleEmail).once("value");
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
                message: "Vous avez déjà un projet en attente. Activez-le avant d'en créer un autre."
            });
        }

        // 4. Envoi de l'icône à Cloudinary (seulement si la limite n'est pas atteinte)
        const imageUrl = await envoyerImage(image);
        if (!imageUrl) {
            return reponse(502, { success: false, message: "L'envoi de l'icône a échoué. Réessayez." });
        }

        // 5. Identifiant unique du projet et horodatage serveur
        const id = randomUUID();
        const horodatage = admin.database.ServerValue.TIMESTAMP;

        // 6. Enregistrement en une seule opération sous <cleEmail>/<id> et <id>
        const miseAJour = {};

        miseAJour[cleEmail + "/" + id] = {
            nom: manifeste.name,
            formule: formule,
            statut: "en_attente",
            creeLe: horodatage,
            installs_total: 0,
            imageUrl: imageUrl,
            demande_reactivation: false
        };

        miseAJour[id] = {
            creeLe: horodatage,
            installs_total: 0,
            manifeste: manifeste,
            stats: {
                installs_total: 0,
                installs_par_jour: {},
                os: {},
                pays: {}
            }
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
