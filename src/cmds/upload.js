import { asJson } from '../impl/args.js';
import { google } from 'googleapis';
import fs from 'fs';
import Path from 'path';
import express from 'express';
import open from 'open';
import mime from 'mime-types';
import { absPath } from '../impl/filesystem.js'

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

const listLocalFiles = async (dirPath, callback) => {
    const fullPath = absPath(dirPath);

    try {
        const ls = fs.readdirSync(dirPath);
        for (const file of ls) {
            try {
                const filePath = Path.join(dirPath, file);
                const stats = fs.statSync(filePath);
                if (stats.isDirectory()) {
                    await callback(filePath, stats);
                    await listLocalFiles(filePath, callback);
                } else {
                    await callback(filePath, stats);
                }
            } catch (err) {
                console.log('Error getting file stats:', err);
            }
            
        }
    } catch (err) {
        console.log(`Unable to get file listing from ${dirPath}`, err);
    }
}

const printRemoteFileListing = async (drive, folderId, indent) => {
    try {
        const response = await drive.files.list({
            q: `'${folderId}' in parents`, 
            fields: "files(id, name, mimeType, size)"
        });
        let files = response.data.files;
        if (files && files.length > 0) {
            for (let i = 0; i < files.length; i++) {
                if (files[i].mimeType === 'application/vnd.google-apps.folder') {
                    // console.log(`${indent} + ${files[i].name} (${files[i].id})`);
                    console.log(`${indent} + ${files[i].name}`);
                    await printRemoteFileListing(drive, files[i].id, `  ${indent}`);
                } else {
                    // console.log(`${indent} ${files[i].name} (${files[i].id})`);
                    console.log(`${indent} ${files[i].name} (${files[i].size} bytes) -> ${files[i].mimeType}`);
                    
                }
            }
        } else {
            console.log(`${indent} This folder is empty.`);
        }
    } catch (e) {
        console.log(`unable to list files: ${e.message}`, e);
    }
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
    },
    printTarget: {
        alias: 'p',
        describe: 'print folders and files structure on the destination Google Drive upon completion',
        type: 'boolean',
        default: false
    }
};

const getFolderIdByName = async (drive, parentId, name) => {
    const query = `'${parentId}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const response = await drive.files.list({
        q: query,
        fields: "files(id)"
    });

    if (response.data.files.length > 0) {
        return response.data.files[0].id;
    } else {
        return null;
    }
} 

const createFolder = async (drive, parentId, name) => {
    const r = {
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
    };

    const response = await drive.files.create({
        resource: r,
        fields: 'id',
    });

    return response.data.id;
}

const folderIdCache = {};

const getOrCreateFolderByPath = async (drive, parentId, pathParts) => {
    let lastParentId = parentId;
    let relPath = '';

    for (const pathIndex in pathParts) {
        const folderName = pathParts[pathIndex];
        relPath = (pathIndex === '0') ? folderName : `${relPath}/${folderName}`;
        // console.log(`${pathIndex}. ${folderName} in ${relPath} getting folder id`);
      
        let folderId = (relPath in folderIdCache) ? folderIdCache[relPath] : null;
        if(folderId) {
            // console.log(`${relPath} found folder id in cache`);
            lastParentId = folderId;
            continue;
        }

        folderId = await getFolderIdByName(drive, lastParentId, folderName);
        if (folderId) {
            // console.log(`${relPath} found folder id on google drive`);
            lastParentId = folderId;
            folderIdCache[relPath] = lastParentId;
        } else {
            lastParentId = await createFolder(drive, lastParentId, folderName);
            folderIdCache[relPath] = lastParentId;
        }
    }

    return lastParentId;
}

const formatFileSize = (bytes, decimals = 2) => {
    if (bytes === 0) return '0 MB';

    const megabytes = (bytes / (1024 * 1024)).toFixed(decimals);
    return `${megabytes} MB`;
}

const doUpload = async (drive, folderId, documentPath, pathParts, fileCount, fileSize) => {
    console.log(`${fileCount}. ${documentPath} uploading ${formatFileSize(fileSize)}`);
    const fileName = pathParts[pathParts.length-1];
    const contentType = mime.lookup(fileName);
    const googleDocName = fileName.split('\.')[0];
    const parentId = (pathParts.length > 1) ? await getOrCreateFolderByPath(drive, folderId, pathParts.slice(0, pathParts.length-1)) : folderId;
    const metadata = {
        name: fileName,
        mimeType: contentType,
        fields: "files(id, name, mimeType, size)",
        parents: [parentId] 
    };

    const stream = fs.createReadStream(documentPath);

    try {
        const resp = await drive.files.create({
            requestBody: metadata,
            media: {
                name: fileName,
                mimeType: contentType,
                body: stream,
            }
        });
        // console.log(`Uploaded ${documentPath}. Google ID: ${resp.data.id}; Mime Type: ${resp.data.mimeType}`);

        if (resp.data.mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            console.log(`   ${fileName} converting to google document '${googleDocName}'`);
            // convert to google doc
            const docId = resp.data.id;
            drive.files.copy({
                fileId: docId,
                requestBody: {
                    name: googleDocName,
                    mimeType: "application/vnd.google-apps.document",
                    parents: [parentId]
                }
            },
            async (err, file) => {
                if (err) {
                    console.log(` Unable to convert ${documentPath} to google doc: ${err.message}`);
                } else {
                    // console.log(`Google Document created: ${file.data.name}. Deleting uploaded ${fileName}`);
                    drive.files.delete({fileId: docId});
                }
            });
        }
    } catch (err) {
        console.log(`Unable to upload ${documentPath}`, err);
    }
}

const handler = async (argv) => {
    const credentials = await asJson(argv.credentials);
    authorize(credentials, async (auth) => {
        console.log(`Login Successful. Ready to upload to folder '${argv.target}'!`);
        const drive = google.drive({ version: 'v3', auth });

        const source = absPath(argv.source);
        let fileCount = 0;
        await listLocalFiles(source, async (filePath, stats) => {
            const relPath = (source.endsWith('/')) ? filePath.substring(source.length) : filePath.substring(source.length+1);
            // console.log(`${fileCount}. Uploading to Google Dive ${filePath}`);
            if (stats.isDirectory()) {
                // pre-process folders
                await getOrCreateFolderByPath(drive, argv.target, relPath.split('/'));
            } else {
                fileCount += 1;
                await doUpload(drive, argv.target, filePath, relPath.split('/'), fileCount, stats.size);
            }
        });

        if (argv.printTarget) {
            await printRemoteFileListing(drive, argv.target, '');
        }
    });
};

export default {
    command,
    desc,
    builder,
    handler
}