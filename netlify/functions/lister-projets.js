// ==========================================
// Fichier : lister-projets.js
// Lit les projets sous <cleEmail>, déduit "suspendu" à partir de
// creeLe et installs_total, et ne lit ni ne renvoie les stats
// si le projet est suspendu ou en attente.
// Le statut renvoyé est TOUJOURS cohérent : si suspendu est déduit,
// seul "suspendu" ressort, aucun autre statut.
// ==========================================

import admin from "firebase-admin";

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_ADMIN_SECRET)),
        databaseURL: process.env.FIREBASE_DB_URL
    });
}

const db = admin.database();

const NIVEAU_FORMULE = { "decouverte": 0, "pro": 1, "pro-plus": 2 };
const JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

const SEUIL_INSTALLS = 50;
const DUREE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

function reponse(statusCode, objet) {
    return {
        statusCode: statusCode,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(objet)
    };
}

function niveauDe(formule) {
    const n = NIVEAU_FORMULE[formule];
    return typeof n === "number" ? n : 0;
}

function estSuspendu(creeLe, installsTotal, maintenantMs) {
    const installs = Number(installsTotal) || 0;
    const dateCreation = Number(creeLe) || 0;
    if (installs <= SEUIL_INSTALLS || !dateCreation) {
        return false;
    }
    return maintenantMs > (dateCreation + DUREE_GRACE_MS);
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
function statsAutorisees(brut, niveau, installsProjet) {
    const s = brut || {};
    const totalInstalls = Number(installsProjet ?? s.installs_total) || 0;

    const resultat = {
        installs_total: totalInstalls,
        installs_7j: installs7j(s),
        index_aujourdhui: indexAujourdhui()
    };

    if (niveau >= 1) {
        resultat.lancements_accueil = Number(s.lancements_accueil) || 0;
        resultat.lancements_navigateur = Number(s.lancements_navigateur) || 0;
        resultat.duree_accueil_total_sec = Number(s.duree_accueil_total_sec) || 0;
        resultat.duree_navigateur_total_sec = Number(s.duree_navigateur_total_sec) || 0;
    }

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

        // 3. Lecture directe sous <cleEmail> + déduction du statut suspendu
        const snapProjets = await db.ref(cleEmail).once("value");

        if (!snapProjets.exists()) {
            return reponse(200, { success: true, projets: [] });
        }

        const maintenantMs = Date.now();
        const projets = [];

        snapProjets.forEach(function (enfant) {
            const p = enfant.val() || {};
            const creeLe = Number(p.creeLe) || 0;
            const installsTotal = Number(p.installs_total) || 0;
            const suspendu = estSuspendu(creeLe, installsTotal, maintenantMs);

            // Le statut "suspendu" est DÉDUIT, pas stocké en base.
            // S'il est déduit suspendu, SEUL "suspendu" ressort.
            // Sinon, on reprend le statut d'origine.
            const statut = suspendu ? "suspendu" : (p.statut || "");

            const element = {
                id: enfant.key,
                nom: p.nom || "",
                formule: p.formule || "",
                statut: statut,
                creeLe: creeLe,
                imageUrl: p.imageUrl || "",
                demande_reactivation: Boolean(p.demande_reactivation)
            };

            // On n'expose pas installs_total si le projet est suspendu
            if (!suspendu) {
                element.installs_total = installsTotal;
            }

            projets.push(element);
        });

        // 4. Lecture des stats uniquement si le projet n'est ni en attente ni suspendu
        const lectures = projets.map(function (p) {
            if (p.statut === "en_attente" || p.statut === "suspendu") {
                return Promise.resolve(null);
            }
            return db.ref(p.id + "/stats").once("value");
        });
        const snapsStats = await Promise.all(lectures);

        // 5. Filtrage des stats selon la formule (jamais attachées si suspendu ou en attente)
        projets.forEach(function (p, i) {
            if (p.statut !== "en_attente" && p.statut !== "suspendu" && snapsStats[i]) {
                p.stats = statsAutorisees(snapsStats[i].val(), niveauDe(p.formule), p.installs_total);
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
