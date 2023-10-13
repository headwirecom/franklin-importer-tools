import { google } from 'googleapis';
import { asJson } from '../impl/args.js';
import fs from 'fs';
import { resolve } from 'path';

let drive = null;

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = 'token.json';
const OAUTH_REDIRECT_PORT = 3333;
const OAUTH_REDIRECT_SERVER = `http://localhost:${OAUTH_REDIRECT_PORT}`;

function getNewToken(oAuth2Client, callback) {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });

    const app = express();
    const server = app.listen(OAUTH_REDIRECT_PORT, () => {
        console.log(`waiting for Auth code on port ${OAUTH_REDIRECT_PORT}`);
    });
    app.get('/', (req, res) => {
        const code = req.query.code;
        if (code) {
            oAuth2Client.getToken(code, (err, token) => {
                if (err) {
                    res.send('<html><h3>Authentication Code Not Received! You can close this window.</h3></html>');
                    server.close(() => { console.log('Auth server shutdown without receiving valid auth code'); });
                    return console.log('Error retrieving access token', err);    
                }

                res.send('<html><h3>Authentication Code Received! You can close this window.</h3></html>');
                server.close(() => { console.log('Auth server shutdown'); });

                oAuth2Client.setCredentials(token);
                // Store the token to disk for later program executions
                fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
                if (err) return console.log(err);
                console.log('Token stored to', TOKEN_PATH);
                });
                callback(oAuth2Client);
            });
        } else {
            const errorCode = (req.query.error) ? req.query.error : 'Unknown Error';
            res.send(`<html><h3>Authentication Code Not Received (${errorCode})! You can close this window and try again.</h3></html>`);
            server.close(() => { console.log(`Auth server shutdown without receiving valid auth code. ${errorCode}`); });
        }
    });

    open(authUrl);
}

function authorize(credentials, callback) {
    const {client_secret, client_id, redirect_uris} = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(
        client_id, client_secret, OAUTH_REDIRECT_SERVER);

    // Check if we have previously stored a token.
    fs.readFile(TOKEN_PATH, (err, token) => {
        if (err) return getNewToken(oAuth2Client, callback);
        oAuth2Client.setCredentials(JSON.parse(token));
        callback(oAuth2Client);
    });
}

function authCheck() {
    if (drive === null) {
        throw new Error('DriveAPI is not initialized yet. Call init method first.');
    }
}

export default class DriveAPI {

    /**
    * Create an OAuth2 client with the given credentials, and then execute the
    * given callback function.
    * @param {string} credentialsPath The path to authorization client credentials JSON file.
    * @param {function} callback The callback to call with the reference to authorized Google Drive API client object.
    */
    init(credentialsPath, callback) {
        return new Promise((resolve, reject) => {
            asJson(credentialsPath).then((credentials) => {
                authorize(credentials, async (auth) => {
                    console.log(`Google Drive API Login Successful.`);
                    drive = google.drive({ version: 'v3', auth });
                    if (callback) {
                        callback(drive);
                    }
                    resolve(drive);
                });
            }).catch((err) => {
                console.log(`Unable to load Google Drive API. Credentials file ${credentialsPath}: ${err.message}`);
                reject(err);
            });
        });
    }

    /**
     * Scan Google Drive folders and call callback function for each file.
     * 
     * @param {string} folderId Folder id for the folder to start scan.
     * @param {function} callback Function to call for each file.
     * @param {boolean} deep If set to true perform deep scan on all subfolders 
     * @param {string} path Path string. This will be prepended to each file name and passed back 
     *                      callback function along with file object.
     */
    async scanFiles(folderId, callback, deep = false, path = '') {
        authCheck();
        try {
            const response = await drive.files.list({
                q: `'${folderId}' in parents and trashed = false`, 
                fields: "files(id, name, mimeType, size, parents)"
            });
            let files = response.data.files;
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    const currentPath = (path.length > 0) ? `${path}/${files[i].name}` : `${files[i].name}`
                    if (files[i].mimeType === 'application/vnd.google-apps.folder') {
                        if (deep) {
                            await this.scanFiles(files[i].id, callback, deep, currentPath);
                        }
                    } else {
                        await callback(files[i], currentPath);
                    }
                }
            } else if (path.length === 0) {
                console.log(`${currentPath} empty folder`);
            }
        } catch (e) {
            console.log(`unable to list files in folder ${path}. Folder id ${folderId}: ${e.message}`, e);
        }
    }
}