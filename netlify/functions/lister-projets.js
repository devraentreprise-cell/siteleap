// ==========================================
// Fichier : lister-projets.js
// Renvoie les projets du client connecté, avec uniquement
// les statistiques autorisées par la formule de chaque projet
// ==========================================

import admin from "firebase-admin";

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_SECRET)),
        databaseURL: process.env.FIREBASE_DB_URL
    });
}

const db = admin.database();

// Niveau de chaque formule : plus le niveau est haut, plus on voit de statistiques
const NIVEAU_FORMULE = { "decouverte": 0, "pro": 1, "pro-plus": 2 };
const JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

function reponse(statusCode, objet) {
    return { statusCode: statusCode, body: JSON.stringify(objet) };
}

function niveauDe(formule) {
    const n = NIVEAU_FORMULE[formule];
    return typeof n === "number" ? n : 0;
}

// Position d'aujourd'hui dans la semaine (0 = lundi ... 6 = dimanche), à l'heure du Cameroun
function indexAujourdhui() {
    const dateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Douala",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
    const parties = dateStr.split("-").map(Number);
    const jourSemaine = new Date(Date.UTC(parties[0], parties[1] - 1, parties[2])).getUTCDay();
    return (jourSemaine + 6) % 7;
}

// Transforme installs_par_jour (lundi ... dimanche) en liste de 7 nombres
function installs7j(stats) {
    const parJour = stats.installs_par_jour || {};
    return JOURS.map(function (jour) {
        return Number(parJour[jour] && parJour[jour].installs) || 0;
    });
}

// Met la liste des pays sous la forme attendue par l'écran
function listerPays(brut) {
    if (!brut) return [];
    const liste = Array.isArray(brut) ? brut : Object.values(brut);
    return liste
        .map(function (p) {
            p = p || {};
            return {
                nom: String(p.nom || ""),
                lat: Number(p.lat) || 0,
                lng: Number(p.lng) || 0,
                count: Number(p.count) || 0
            };
        })
        .filter(function (p) { return p.count > 0; });
}

// Ne garde que ce que la formule autorise
function statsAutorisees(brut, niveau) {
    const s = brut || {};

    // Niveau 0 (Découverte) : installations
    const resultat = {
        installs_total: Number(s.installs_total) || 0,
        installs_7j: installs7j(s),
        index_aujourdhui: indexAujourdhui()
    };

    // Niveau 1 (Pro) : + usage
    if (niveau >= 1) {
        resultat.lancements_accueil = Number(s.lancements_accueil) || 0;
        resultat.lancements_navigateur = Number(s.lancements_navigateur) || 0;
        resultat.duree_accueil_total_sec = Number(s.duree_accueil_total_sec) || 0;
        resultat.duree_navigateur_total_sec = Number(s.duree_navigateur_total_sec) || 0;
    }

    // Niveau 2 (Pro+) : + appareils et pays
    if (niveau >= 2) {
        resultat.installs_android = Number(s.installs_android) || 0;
        resultat.installs_ios = Number(s.installs_ios) || 0;
        resultat.installs_pc = Number(s.installs_pc) || 0;
        resultat.pays = listerPays(s.pays);
    }

    return resultat;
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
        if (!jeton || typeof jeton !== "string") {
            return reponse(401, { success: false, message: "Connexion Google manquante." });
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

        // Même règle de nom de tiroir que creer-projet.js
        const cleEmail = email.trim().toLowerCase().replace(/\./g, ",").replace(/[#$\[\]\/]/g, "_");

        // 3. Lecture des projets de cet email
        const snapProjets = await db.ref("projets/" + cleEmail).once("value");

        if (!snapProjets.exists()) {
            return reponse(200, { success: true, projets: [] });
        }

        const projets = [];
        snapProjets.forEach(function (enfant) {
            const p = enfant.val() || {};
            projets.push({
                id: enfant.key,
                nom: p.nom || "",
                formule: p.formule || "",
                statut: p.statut || "",
                creeLe: p.creeLe || 0,
                imageUrl: p.imageUrl || ""
            });
        });

        // 4. Lecture des statistiques UNIQUEMENT pour les projets actifs
        //    (en attente ou suspendu : aucune statistique n'est lue ni envoyée)
        const lectures = projets.map(function (p) {
            if (p.statut !== "actif") return Promise.resolve(null);
            return db.ref("stats/" + p.id).once("value");
        });
        const snapsStats = await Promise.all(lectures);

        // 5. On ne garde que ce que la formule autorise
        projets.forEach(function (p, i) {
            if (p.statut === "actif" && snapsStats[i]) {
                p.stats = statsAutorisees(snapsStats[i].val(), niveauDe(p.formule));
            }
        });

        // 6. Du plus récent au plus ancien
        projets.sort(function (a, b) {
            return b.creeLe - a.creeLe;
        });

        return reponse(200, { success: true, projets: projets });

    } catch (error) {
        console.error("Erreur technique dans lister-projets :", error);
        return reponse(500, { success: false, message: "Erreur technique lors de la lecture des projets." });
    }
}
