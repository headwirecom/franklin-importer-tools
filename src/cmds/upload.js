import { asJson } from '../impl/args.js';
import { google } from 'googleapis';
import fs from 'fs';
import Path from 'path';
import express from 'express';
import open from 'open';
import mime from 'mime-types';
import { absPath } from '../impl/filesystem.js'
import ReportUtil from '../impl/ReportUtil.js';
import ConcurrencyUtil from '../impl/ConcurrencyUtil.js';

let drive = null;

const command = 'upload';
const desc = 'upload site content to Google Drive';

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = 'token.json';
const OAUTH_REDIRECT_PORT = 3333;
const OAUTH_REDIRECT_SERVER = `http://localhost:${OAUTH_REDIRECT_PORT}`;

const RATE_LIMIT_ERR = 'User rate limit';

const uploadStatus = {
    rows: []
};

const report = (path, status, fileSize = '', message = '') => {
    uploadStatus.rows.push({path, status, fileSize, message})
} 

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

const hasFiles = (dirPath) => {
    try {
        const ls = fs.readdirSync(dirPath);
        for (const file of ls) {
            // skip macOS specific files and upload report 
            if (file === '.DS_Store' || file === 'upload-report.xlsx' || file === 'import-report.xlsx') continue;
            try {
                const filePath = Path.join(dirPath, file);
                const stat = fs.statSync(filePath);
                if (stat.isFile()) {
                    return true;
                }
            } catch (err) {
                console.log('Error getting file stats:', err);
            }
        }
    } catch (err) {
        console.log(`Unable to get file listing from ${dirPath}`, err);
    }
    return false;
}

const listLocalFiles = async (dirPath, callback) => {
    const fullPath = absPath(dirPath);

    try {
        const ls = fs.readdirSync(dirPath);
        for (const file of ls) {
            // skip macOS specific files and upload report 
            if (file === '.DS_Store' || file === 'upload-report.xlsx') continue;
            try {
                const filePath = Path.join(dirPath, file);
                const stats = fs.statSync(filePath);
                if (stats.isDirectory()) {
                    await callback(filePath, stats);
                    await listLocalFiles(filePath, callback);
                } else if (stats.isFile()) {
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

const updateTimer = () => {
    const totalTime = Math.round((new Date() - uploadStatus.startTime) / 1000);
    let timeStr = `${totalTime}s`;
    if (totalTime > 60) {
      timeStr = `${Math.round(totalTime / 60)}m ${totalTime % 60}s`;
      if (totalTime > 3600) {
        timeStr = `${Math.round(totalTime / 3600)}h ${Math.round((totalTime % 3600) / 60)}m`;
      }
    }
    uploadStatus.timeStr = timeStr;
    return uploadStatus.timeStr;
}

const printRemoteFileListing = async (folderId, indent) => {
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
                    await printRemoteFileListing(files[i].id, `  ${indent}`);
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
    async: {
        description: "number of documents to upload asynchronously",
        type: "number",
        default: 10
    },
    printTarget: {
        alias: 'p',
        describe: 'print folders and files structure on the destination Google Drive upon completion',
        type: 'boolean',
        default: false
    }
};

const getFolderIdByName = async (parentId, name) => {
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

const isRateLimitError = (err) => {
    return (err && err.message.includes(RATE_LIMIT_ERR));
}

const backoff = (call, onSuccess, onError, exponent = 0, retry = 0, maxRetries = 20) => {
    const delay = (exponent > 0) ? Math.min((Math.pow(2, exponent) + Math.random() * 1000), 64000) : 1;
    setTimeout(async () => {
        try {
            const resp = await call();
            onSuccess(resp);
        } catch(err) {
            if (isRateLimitError(err) && retry <= maxRetries) {
                // console.log('back off retry', err);
                backoff(call, onSuccess, onError, exponent + 1, retry + 1, maxRetries);
            } else {
                onError(err);
            }
        }
    }, delay);
}

const createFolder = async (parentId, name) => {
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

const getOrCreateFolderByPath = async (parentId, pathParts) => {
    let lastParentId = parentId;
    let relPath = '';

    for (const pathIndex in pathParts) {
        const folderName = pathParts[pathIndex];
        relPath = (pathIndex === '0') ? folderName : `${relPath}/${folderName}`;
        //console.log(`${pathIndex}. ${folderName} in ${relPath} getting folder id`);
      
        let folderId = (relPath in folderIdCache) ? folderIdCache[relPath] : null;
        if(folderId) {
            // console.log(`${relPath} found folder id in cache`);
            lastParentId = folderId;
            continue;
        }

        folderId = await getFolderIdByName(lastParentId, folderName);
        if (folderId) {
            // console.log(`${relPath} found folder id on google drive`);
            lastParentId = folderId;
            folderIdCache[relPath] = lastParentId;
        } else {
            lastParentId = await createFolder(lastParentId, folderName);
            folderIdCache[relPath] = lastParentId;
        }
    }

    return lastParentId;
}

const formatFileSize = (bytes, decimals = 2) => {
    if (bytes === 0) return '0 MB';

    const megabytes = (bytes / (1024 * 1024)).toFixed(decimals);
    if (megabytes > 1024) {
        const gigabytes = (megabytes / 1024).toFixed(decimals);
        return `${gigabytes} GB`;
    }
    return `${megabytes} MB`;
}

const tryToDeleteDocument = (id) => {
    drive.files.delete({fileId: id}, (err) => {
        if (isRateLimitError(err)) {
            backoff(async () => {
                await drive.files.delete({fileId: id});
            }, 
            () => { console.log(`Document '${id}' deleted on retry.`); }, 
            (err) => { console.log(`Document '${id}' not deleted on retry. ${err.message}`); });
        }
    });
}

const tryToConvertDocument = async (folderId, docId, fileName, path, fileSize) => {
    const source = uploadStatus.sourceDir;
    const relPath = (source.endsWith('/')) ? path.substring(source.length) : path.substring(source.length+1);
    const googleDocName = fileName.split('\.')[0];
    const callback = async () => {
        // const stack = new Error();
        // console.log(`callback to convert ${fileName}`, stack);
        const resp = await drive.files.copy({
            fileId: docId,
            requestBody: {
                name: googleDocName,
                mimeType: "application/vnd.google-apps.document",
                parents: [folderId]
            }
        });
        return resp;
    }

    const p = new Promise(async (resolve) => { 
        backoff(
            callback, 
            (resp) => { 
                console.log(`Document ${fileName} (${fileSize}) with Google ID '${docId}' converted. Time ${updateTimer()}.`); 
                tryToDeleteDocument(docId);
                report(relPath, 'success', fileSize);
                uploadStatus.processing -= 1;
                resolve();
            }, (err) => {
                const msg = `Unable to convert '${fileName}' (${fileSize}). ${err.message}. Time ${updateTimer()}.`;
                console.log(msg);
                report(relPath, 'error', fileSize, msg);
                uploadStatus.processing -= 1;
                resolve();
            });
    });

    return p;
}

const isFileTooLarge = (bytes) =>{
    // Documents larger than 100 MB always fail to convert
    const megabytes = (bytes / (1024 * 1024)).toFixed(2);
    return megabytes > 100;
}

const tryToUploadDocument = (folderId, path, fileName, fileSize) => {
    const source = uploadStatus.sourceDir;
    const relPath = (source.endsWith('/')) ? path.substring(source.length) : path.substring(source.length+1);
    const formatedSize = formatFileSize(fileSize);
    const contentType = mime.lookup(fileName);
    const metadata = {
        name: fileName,
        mimeType: contentType,
        fields: "files(id, name, mimeType, size)",
        parents: [folderId] 
    };
    
    const callback = async () => {
        const stream = fs.createReadStream(path);
        const resp = await drive.files.create({
            requestBody: metadata,
            media: {
                name: fileName,
                mimeType: contentType,
                body: stream,
            }
        });
        return resp;
    }

    const p = new Promise(async (resolve) => { 
        backoff(
            callback, 
            (resp) => { 
                console.log(`Uploaded document ${path} (${formatedSize}). Time ${updateTimer()}.`); 
                if (resp.data.mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                    if (!isFileTooLarge(fileSize)) {
                        console.log(`${fileName} converting to google document`);
                        // convert to google doc
                        const docId = resp.data.id;
                        tryToConvertDocument(folderId, docId, fileName, path, formatedSize).then(() => {
                            resolve();
                        });
                    } else {
                        const msg = `${formatedSize} too large to convert to google document`;
                        console.log(`${path} - ${msg}`);
                        report(relPath, 'error', formatedSize, msg);
                        uploadStatus.processing -= 1;
                        resolve();
                    }
                } else {
                    report(relPath, 'success', formatedSize);
                    uploadStatus.processing -= 1;
                    resolve();
                }
            }, 
            (err) => {
                console.log(`Unable to upload ${path} (${formatedSize}). ${err.message}. Time ${updateTimer()}.`);
                report(relPath, 'error', formatedSize, `Unable to upload: ${err.message}`);
                uploadStatus.processing -= 1;
                resolve();
            });
    });

    return p;
}

const doUpload = async (folderId, documentPath, pathParts, fileSize) => {
    const fileName = pathParts[pathParts.length-1];
    const formatedSize = formatFileSize(fileSize);
    const parentId = (pathParts.length > 1) ? await getOrCreateFolderByPath(folderId, pathParts.slice(0, pathParts.length-1)) : folderId;
    
    try {
        await tryToUploadDocument(parentId, documentPath, fileName, fileSize);
    } catch (err) {
        console.log(`Unable to upload document ${documentPath}. Time ${updateTimer()}.`, err);
        report(documentPath, 'error', formatedSize, `Unable to upload: ${err.message}`);
    }

    uploadStatus.fileCount += 1;
    console.log(`${uploadStatus.fileCount}. ${documentPath} (${formatedSize}) finished. Time ${updateTimer()}.`);  
}

const finish = async () => {
    if (uploadStatus.processing > 0) {
        setTimeout(finish, 500);
    } else {
        if (uploadStatus.printTarget) {
            await printRemoteFileListing(argv.target, '');
        }
        console.log(`Saving upload report. Time ${updateTimer()}`);
        await ReportUtil.saveReport(uploadStatus, uploadStatus.sourceDir, 'upload-report', 'Upload Report', ['path', 'status', 'fileSize', 'message']);
        updateTimer();
        console.log(`Uploaded ${uploadStatus.fileCount} files in ${uploadStatus.timeStr}.`);
    }
}

const handler = async (argv) => {
    const credentials = await asJson(argv.credentials);
    authorize(credentials, async (auth) => {
        console.log(`Login Successful. Ready to upload to folder '${argv.target}'!`);
        drive = google.drive({ version: 'v3', auth });

        const source = absPath(argv.source);
        uploadStatus.startTime = Date.now();
        uploadStatus.fileCount = 0;
        uploadStatus.totalSizeUpload = 0;
        uploadStatus.processing = 0; 
        uploadStatus.sourceDir = source;
        uploadStatus.printTarget = argv.printTarget

        const entries = [];

        console.log('Scanning directories and files to upload. Creating Google Drive folder structure.');
        await listLocalFiles(source, async (filePath, stats) => {
            const relPath = (source.endsWith('/')) ? filePath.substring(source.length) : filePath.substring(source.length+1);
            if (stats.isFile()) {
                uploadStatus.totalSizeUpload = uploadStatus.totalSizeUpload + stats.size;
                entries.push(filePath)
            } else if (stats.isDirectory() && hasFiles(filePath)) {
                await getOrCreateFolderByPath(argv.target, relPath.split('/'));
                console.log(`Google Folder ${relPath} created. Time ${updateTimer()}`);
            }
        });

        const totalSizeFormatted = formatFileSize(uploadStatus.totalSizeUpload);
        console.log(`Uploading ${entries.length}. Total data to upload ${totalSizeFormatted}.`);

        if (entries.length > 0) {
            const asyncCallback = async (filePath, options, index, array) => {
                return new Promise(async (resolve) => {
                    try {
                        const relPath = (source.endsWith('/')) ? filePath.substring(source.length) : filePath.substring(source.length+1);
                        let stat = fs.statSync(filePath);
                        console.log(`${index+1}/${entries.length}. Uploading ${filePath} ${formatFileSize(stat.size)}`)
                        uploadStatus.processing += 1;
                        await doUpload(argv.target, filePath, relPath.split('/'), stat.size);
                    } catch(err) {
                        console.log(`Unable to upload ${filePath}.`, err);
                        report(filePath, 'error', 0, `Unable to upload ${filePath}. ${err.message}`);
                    }
                    resolve();
                });
            }

            ConcurrencyUtil.processAll(entries, asyncCallback, {}, argv.async, 3000, true).then(() => finish());
        }
    });
};

export default {
    command,
    desc,
    builder,
    handler
}