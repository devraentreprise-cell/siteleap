import admin from 'firebase-admin';

// Initialisation de Firebase Admin
if (!admin.apps.length) {
  try {
    // On lit la clé secrète depuis les variables d'environnement Netlify
    const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SECRET);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL 
    });
  } catch (error) {
    console.error('Erreur d\'initialisation Firebase Admin:', error);
  }
}

// Utilisation de "export const handler" au lieu de "exports.handler" (ESM)
export const handler = async (event, context) => {
  // 1. On n'accepte que les requêtes POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { pseudo, email, whatsapp, jeton } = JSON.parse(event.body);

    // 2. Vérification basique des données
    if (!pseudo || !email || !whatsapp) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ success: false, message: 'Tous les champs sont obligatoires.' }) 
      };
    }

    // 3. (Sécurité) Vérifier que le jeton de l'utilisateur est valide
    if (jeton) {
      try {
        await admin.auth().verifyIdToken(jeton);
      } catch (error) {
        return { 
          statusCode: 401, 
          body: JSON.stringify({ success: false, message: 'Session invalide ou expirée.' }) 
        };
      }
    }

    // 4. Enregistrement dans Firestore (Collection "liste_attente")
    await admin.firestore().collection('liste_attente').add({
      pseudo: pseudo,
      email: email,
      whatsapp: whatsapp,
      date_inscription: admin.firestore.FieldValue.serverTimestamp()
    });

    // 5. On renvoie le succès au front-end pour déclencher la redirection
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: 'Inscription enregistrée avec succès.' })
    };

  } catch (error) {
    console.error('Erreur serveur:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, message: 'Erreur interne du serveur.' })
    };
  }
};
