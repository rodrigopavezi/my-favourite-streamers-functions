/* eslint-disable promise/always-return */
/* eslint-disable promise/catch-or-return */
const functions = require("firebase-functions");
var admin = require("firebase-admin");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const cors = require("cors")({
  origin: "https://my-favourite-streamers.firebaseapp.com",
  credentials: true,
});
const request = require("request");
const firebase = require("firebase");

var serviceAccount = require("./service-account.json");
const APP_NAME = "my-favourite-streamers";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://my-favourite-streamers.firebaseio.com",
});

const db = admin.firestore();

const OAUTH_REDIRECT_URI = `https://my-favourite-streamers.firebaseapp.com/redirect`;
const OAUTH_SCOPES = "user_read";

/**
 * Creates a configured simple-oauth2 client for Twitch.
 */
function twitchOAuth2Client() {
  // Twitch OAuth 2 setup
  // TODO: Configure the `twitch.client_id` and `twitch.client_secret` Google Cloud environment variables.
  const credentials = {
    client: {
      id: functions.config().twitch.client_id,
      secret: functions.config().twitch.client_secret,
    },
    auth: {
      tokenHost: "https://id.twitch.tv",
      tokenPath: "/oauth2/token",
      authorizePath: "/oauth2/authorize",
    },
  };
  return require("simple-oauth2").create(credentials);
}

/**
 * Redirects the User to the Twitch authentication consent screen. Also the 'state' cookie is set for later state
 * verification.
 */
exports.redirect = functions.https.onRequest((req, res) => {
  return cors(req, res, () => {
    const oauth2 = twitchOAuth2Client();

    cookieParser()(req, res, () => {
      const state = req.cookies.state || crypto.randomBytes(20).toString("hex");
      console.log("Setting verification state:", state);
      res.cookie("state", state.toString(), {
        maxAge: 3600000,
        secure: true,
        httpOnly: true,
        sameSite: "none",
      });
      const redirectUri = oauth2.authorizationCode.authorizeURL({
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: OAUTH_SCOPES,
        state: state,
      });
      console.log("Redirecting to:", redirectUri);
      res.redirect(redirectUri);
    });
  });
});

function userProfile(accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      url: "https://api.twitch.tv/helix/users",
      method: "GET",
      headers: {
        "Client-ID": functions.config().twitch.client_id,
        Accept: "application/vnd.twitchtv.v5+json",
        Authorization: "Bearer " + accessToken,
      },
    };

    request(options, (error, response, body) => {
      if (response && response.statusCode === 200) {
        resolve(JSON.parse(body));
      } else {
        reject(JSON.parse(body));
      }
    });
  });
}

/**
 * Exchanges a given Twitch auth code passed in the 'code' URL query parameter for a Firebase auth token.
 * The request also needs to specify a 'state' query parameter which will be checked against the 'state' cookie.
 * The Firebase custom auth token, display name, photo URL and Twitch acces token are sent back in a JSON
 */
exports.token = functions.https.onRequest((req, res) => {
  return cors(req, res, () => {
    const oauth2 = twitchOAuth2Client();

    try {
      cookieParser()(req, res, () => {
        console.log("Received verification state:", req.cookies.state);
        console.log("Received state:", req.query.state);
        if (!req.cookies.state) {
          throw new Error(
            "State cookie not set or expired. Maybe you took too long to authorize. Please try again."
          );
        } else if (req.cookies.state !== req.query.state) {
          throw new Error("State validation failed");
        }
        console.log("Received auth code:", req.query.code);
        oauth2.authorizationCode
          .getToken({
            client_id: functions.config().twitch.client_id,
            client_secret: functions.config().twitch.client_secret,
            code: req.query.code,
            redirect_uri: OAUTH_REDIRECT_URI,
            grant_type: "authorization_code",
          })
          .then((results) => {
            console.log("Auth code exchange result received:", results);

            userProfile(results.access_token)
              .then(async (profile) => {
                console.log("profile", profile);
                // Create a Firebase account and get the Custom Auth Token.
                await createFirebaseAccount(
                  profile.data[0].id,
                  profile.data[0].display_name,
                  profile.data[0].profile_image_url,
                  results.access_token
                )
                  .then((firebaseToken) => {
                    // Serve an HTML page that signs the user in and updates the user profile.
                    res.json({ token: firebaseToken });
                  })
                  .catch((e) => {
                    console.log("createFirebaseAccount error:", e);
                  });
              })
              .catch((e) => {
                console.log("userProfile error:", e);
              });
          })
          .catch((e) => {
            console.log("getToken error:", e);
          });
      });
    } catch (error) {
      return res.json({ error: error.toString });
    }
  });
});

/**
 * Creates a Firebase account with the given user profile and returns a custom auth token allowing
 * signing-in this account.
 * Also saves the accessToken to the datastore at /twitchAccessToken/$uid
 *
 * @returns {Promise<string>} The Firebase custom auth token in a promise.
 */
async function createFirebaseAccount(
  twitchID,
  displayName,
  photoURL,
  accessToken
) {
  // The UID we'll assign to the user.
  const uid = `twitch:${twitchID}`;

  // Save the access token to the Firebase Firestore.
  const docRef = db.collection("users").doc(uid);
  await docRef.set({ accessToken }, { merge: true });

  // Create or update the user account.
  const userCreationTask = admin
    .auth()
    .updateUser(uid, {
      displayName: displayName,
      photoURL: photoURL,
    })
    .catch((error) => {
      // If user does not exists we create it.
      if (error.code === "auth/user-not-found") {
        return admin.auth().createUser({
          uid: uid,
          displayName: displayName,
          photoURL: photoURL,
        });
      }
      throw error;
    });

  // Wait for all async task to complete then generate and return a custom auth token.
  return Promise.all([userCreationTask]).then(() => {
    // Create a Firebase custom auth token.
    return admin
      .auth()
      .createCustomToken(uid)
      .then((token) => {
        console.log('Created Custom token for UID "', uid, '" Token:', token);
        return token;
      });
  });
}

exports.updateUser = functions.firestore
  .document("users/{userId}")
  .onUpdate((change, context) => {
    // Get an object representing the document
    // e.g. {'name': 'Marie', 'age': 66}
    const newValue = change.after.data();

    // access a particular field as you would any JS property
    const newStreamers = newValue.streamers;
    console.log("newValue", newValue);

    const requests = [];
    if (newStreamers && newStreamers.length > 0) {
      newStreamers.map((streamer) => {
        const options = {
          url: "https://api.twitch.tv/helix/webhooks/hub",
          method: "POST",
          headers: {
            "Client-ID": functions.config().twitch.client_id,
            Authorization: "Bearer " + newValue.accessToken,
          },
          json: {
            "hub.callback":
              "https://us-central1-my-favourite-streamers.cloudfunctions.net/twitchStreamNotificationCallback",
            "hub.mode": "subscribe",
            "hub.topic": `https://api.twitch.tv/helix/streams?user_id=${streamer.id}`,
            "hub.lease_seconds": 864000,
          },
        };
        requests.push(
          new Promise((resolve, reject) => {
            request(options, (error, response, body) => {
              if (response && response.statusCode === 200) {
                console.log("JSON.parse(body)", JSON.parse(body));
                resolve(JSON.parse(body));
              } else {
                console.log("JSON.parse(body)", JSON.parse(body));
                reject(JSON.parse(body));
              }
            });
          })
        );
      });

      return Promise.all(requests);
    }
  });

exports.twitchStreamNotificationCallback = functions.https.onRequest(
  (req, res) => {
    return cors(req, res, async () => {
      if (req.method === "GET") {
        return res.send(req.query["hub.challenge"]);
      } else {
        const data = req.body.data;

        const docRef = db.collection("events").doc(data[0].user_id);

        const doc = await docRef.get();
        let appendedEvents = [data[0]];
        if (
          doc &&
          doc.data() &&
          doc.data().events &&
          doc.data().events.length > 0
        ) {
          appendedEvents = [...doc.data().events, ...appendedEvents];
        }

        await docRef.set(
          {
            events: appendedEvents,
          },
          { merge: true }
        );

        return res.json({ sucess: true });
      }
    });
  }
);
