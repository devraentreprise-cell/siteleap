// ==========================================
// Fichier unifié : verifier-paiement.js
// ==========================================

import admin from "firebase-admin";

// Initialisation unique avec l'Admin Secret (outrepasse toutes les règles de sécurité)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_SECRET)),
        databaseURL: process.env.FIREBASE_DB_URL
    });
}

const db = admin.database();

export async function handler(event, context) {
    if (event.httpMethod !== "POST") {
        return { 
            statusCode: 405, 
            body: JSON.stringify({ error: "Méthode non autorisée." }) 
        };
    }

    try {
        const body = JSON.parse(event.body || "{}");
        
        // Extraction robuste des données reçues du navigateur
        const email = body.email || (body.clientData && body.clientData.email);
        const manifestData = body.manifestData || (body.clientData && body.clientData.manifestData);
        const referenceSelar = body.referenceSelar || (body.clientData && body.clientData.referenceSelar);

        if (!referenceSelar || !email) {
            return { 
                statusCode: 400, 
                body: JSON.stringify({ error: "Numéro de référence ou e-mail manquant." }) 
            };
        }

        // 1. Vérification globale dans la BDD pour voir si la référence a déjà été utilisée
        const snapshot = await db.ref().once("value");
        const rootData = snapshot.val();

        let referenceAlreadyUsed = false;
        if (rootData) {
            const findReference = (obj) => {
                if (!obj || typeof obj !== "object") return false;
                for (const key in obj) {
                    if (key === "referenceSelar" && obj[key] === referenceSelar) {
                        return true;
                    }
                    if (findReference(obj[key])) return true;
                }
                return false;
            };
            referenceAlreadyUsed = findReference(rootData);
        }

        if (referenceAlreadyUsed) {
            console.warn(`[Alerte Sécurité] Tentative de réutilisation de la référence : ${referenceSelar}`);
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    success: true, 
                    verified: false, 
                    message: "Cette référence de paiement a déjà été utilisée." 
                })
            };
        }

        // 2. Interrogation de l'API officielle Selar
        const SELAR_API_KEY = "sat_2e99417j2bjl1782n18z1f78977xxa2p2y817";

        const responseAPI = await fetch(`https://api.selar.com/v1/orders/${encodeURIComponent(referenceSelar)}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${SELAR_API_KEY}`,
                "Content-Type": "application/json"
            }
        });

        const texteAPI = await responseAPI.text();
        console.log("[Selar] Code HTTP :", responseAPI.status);
        console.log("[Selar] Réponse :", texteAPI);

        let paymentData = {};
        try { paymentData = JSON.parse(texteAPI); } catch (e) {}

        // 3. Analyse du statut de paiement
        const isPaid = responseAPI.ok && (
            paymentData.status === "paid" || 
            paymentData.status === "success" || 
            (paymentData.data && paymentData.data.status === "paid")
        );

        if (isPaid) {
            // --- PAIEMENT VALIDE : Enregistrement direct dans Firebase via Admin SDK ---
            const emailSanitized = email.trim().toLowerCase().replace(/\./g, '_');
            const cheminAppRef = db.ref(`${emailSanitized}/apps/${referenceSelar}`);

            const donneesProjet = {
                referenceSelar: referenceSelar,
                manifest: manifestData || {},
                stats: {
                    total_installs: 0,
                    browser_launches: 0,
                    homescreen_launches: 0,
                    homescreen_avg_session_duration: 0,
                    elapsed_days: 0,
                    pc_installs: 0,
                    ios_installs: 0,
                    android_installs: 0,
                    installs_by_country: {}
                }
            };

            await cheminAppRef.set(donneesProjet);
            console.log(`[Succès] Projet ${referenceSelar} enregistré pour l'utilisateur : ${email}`);

            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, verified: true })
            };

        } else {
            // --- PAIEMENT INVALIDE OU INEXISTANT ---
            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, verified: false })
            };
        }

    } catch (error) {
        console.error("Erreur technique dans la fonction de vérification:", error);
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: "Erreur technique lors de la vérification et de l'enregistrement." }) 
        };
    }
}
