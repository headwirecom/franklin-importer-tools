import { asJson } from '../impl/args.js';
import { google } from 'googleapis';
import fs from 'fs';
import express from 'express';
import open from 'open';
import  readline from 'readline';
import exp from 'constants';

const command = 'upload';
const desc = 'upload site content to Google Drive';

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = 'token.json';
const OAUTH_REDIRECT_PORT = 3333;
const OAUTH_REDIRECT_SERVER = `http://localhost:${OAUTH_REDIRECT_PORT}`;

/**
* Get and store new token after prompting for user authorization, and then
* execute the given callback with the authorized OAuth2 client.
* @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
* @param {getEventsCallback} callback The callback for the authorized client.
*/
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
                    return console.error('Error retrieving access token', err);    
                }

                res.send('<html><h3>Authentication Code Received! You can close this window.</h3></html>');
                server.close(() => { console.log('Auth server shutdown'); });

                oAuth2Client.setCredentials(token);
                // Store the token to disk for later program executions
                fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
                if (err) return console.error(err);
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

/**
* Create an OAuth2 client with the given credentials, and then execute the
* given callback function.
* @param {Object} credentials The authorization client credentials.
* @param {function} callback The callback to call with the authorized client.
*/
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

const asyncListFiles = async (drive, folderId, indent) => {
    try {
        const response = await drive.files.list({q: `'${folderId}' in parents`, fields: "files(id, name, mimeType, description)"});
        let files = response.data.files;
        if (files && files.length > 0) {
            for (let i = 0; i < files.length; i++) {
                if (files[i].mimeType === 'application/vnd.google-apps.folder') {
                    // console.log(`${indent} + ${files[i].name} (${files[i].id})`);
                    console.log(`${indent} + ${files[i].name}`);
                    await asyncListFiles(drive, files[i].id, `  ${indent}`);
                } else {
                    // console.log(`${indent} ${files[i].name} (${files[i].id})`);
                    console.log(`${indent} ${files[i].name}`);
                }
            }
        } else {
            console.log(`${indent} This folder is empty.`);
        }
    } catch (e) {
        console.log(`unable to list files: ${e.message}`);
        // console.error(e);
    }
}

function listFiles(drive, folderId, indent) {
    // console.log(`Listing files in ${folderId} folder.`);
    drive.files.list({
        q: `'${folderId}' in parents`,
        fields: "files(id, name, mimeType, description)"
    }).then(function(response) {
        let files = response.data.files;
        if (files && files.length > 0) {
            for (let i = 0; i < files.length; i++) {
                if (files[i].mimeType === 'application/vnd.google-apps.folder') {
                    // console.log(`${indent} + ${files[i].name} (${files[i].id})`);
                    console.log(`${indent} + ${files[i].name}`);
                    listFiles(drive, files[i].id, `  ${indent}`);
                } else {
                    // console.log(`${indent} ${files[i].name} (${files[i].id})`);
                    console.log(`${indent} ${files[i].name}`);
                }
            }
        } else {
            console.log(`${indent} This folder is empty.`);
        }
    }).catch((e) => {
        console.log(`unable to list files: ${e.message}`);
        // console.error(e);
    });
}

const builder = {
    target: {
        alias: 't',
        describe: 'folder id of the destination Google Drive folder to upload documents to',
        required: true
    },
    source: {
        alias: 's',
        describe: 'path to local document source folder to upload documents from',
        default: './docs'
    },
    credentials: {
        alias: 'c',
        describe: 'OAuth Client ID credentials (download JSON from Google Developer Console)',
        required: true
    }
};

const handler = async (argv) => {
    const credentials = await asJson(argv.credentials);
    authorize(credentials, (auth) => {
        console.log(`Login Successful. Ready to upload to folder '${argv.target}'!`);
        const drive = google.drive({ version: 'v3', auth });
        asyncListFiles(drive, argv.target, '');
    });
};

export default {
    command,
    desc,
    builder,
    handler
}