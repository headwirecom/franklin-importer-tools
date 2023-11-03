import { asJson } from '../impl/args.js';
import { google } from 'googleapis';
import fs from 'fs';
import Path from 'path';
import mime from 'mime-types';
import { absPath } from '../impl/filesystem.js'
import ReportUtil from '../impl/ReportUtil.js';
import ConcurrencyUtil from '../impl/ConcurrencyUtil.js';
import DriveAPI from '../impl/DriveAPI.js';

let drive = null;
let driveAPI = null; 

const command = 'upload';
const desc = 'upload site content to Google Drive';

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = 'token.json';
const OAUTH_REDIRECT_PORT = 3333;
const OAUTH_REDIRECT_SERVER = `http://localhost:${OAUTH_REDIRECT_PORT}`;

const RATE_LIMIT_ERR = 'User rate limit';

const MODES = {
    uploadAll: 'uploadAll', 
    keepRemote: 'keepRemote', 
    overwrite: 'overwrite', 
    overwriteOlder: 'overwriteOlder',
    convert: 'convert',
    scanonly: 'scanonly'
};
const MODE_VALUES = ['uploadAll', 'keepRemote', 'overwrite', 'overwriteOlder', 'convert', 'scanonly'];
const MODE_DESCRIPTION = [
    { name: 'uploadAll', descriptoin: 'Upload all files without checking. This will create duploacate files on Google Drive if files with the same name exist.' },
    { name: 'keepRemote', descriptoin: 'Upload only if a file with the same name does not exist on Google Drive.' },
    { name: 'overwrite', descriptoin: 'Delete Google Drive file before uploading if it has the same name.' },
    { name: 'overwriteOlder', descriptoin: 'Delete Google Drive file before uploading if it has the same name and has modifiedTime older than local.' },
    { name: 'convert', descriptoin: 'Convert Word documents found on Google drive to Googl Docs if they have not already been converted.' },
    { name: 'scanonly', descriptoin: 'Scan to estimate number of files and total size of upload' }
];

const uploadStatus = {
    rows: []
};

const checkMode = (argv) => {
    if (MODE_VALUES.includes(argv.mode)) {
        return argv.mode;
    }
    throw new Error(`${argv.mode} is not a valid mode value`);
}

const report = (path, status, fileSize = '', message = '') => {
    uploadStatus.rows.push({path, status, fileSize, message})
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

const printRemoteFileListing = async (folderId) => {
    let count = 0;
    await driveAPI.scanFiles(folderId, async (file, path) => {
        count += 1;
        console.log(`${count}. ${path} (${formatFileSize(file.size)}) -> ${file.mimeType}`);
    }, true);
}

const convertToGoogleDocsScan = async (folderId) => {
    await driveAPI.scanFiles(folderId, async (file, path) => {
        if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            console.log(`${path} (${formatFileSize(file.size)}) -> ${file.mimeType}`);
            const folderId = file.parents[0];
            uploadStatus.processing += 1;
            await tryToConvertDocument(folderId, file.id, file.name, path, formatFileSize(file.size));
        }
    }, true);
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
    },
    mode: {
        alias: 'm',
        describe: `Upload mode that specifies how to handle existing files on google ${JSON.stringify(MODE_VALUES)}.
            Upload Modes: ${JSON.stringify(MODE_DESCRIPTION, null, 2)} \n`,
        default: `${MODE_VALUES[0]}`
    },
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
            // retry Google rate limit errors and network timeouts
            if ((isRateLimitError(err) || err.message.includes('connect ETIMEDOUT')) && retry <= maxRetries) {
                // console.log('back off retry', err);
                backoff(call, onSuccess, onError, exponent + 1, retry + 1, maxRetries);
            } else {
                onError(err);
            }
        }
    }, delay);
}

const getGoogleFilesByName = (folderId, fileName) => {
    const query = `'${folderId}' in parents and name = '${fileName}' and mimeType != 'application/vnd.google-apps.folder' and trashed = false`; 

    const callback = async () => {
        const resp = await drive.files.list({
            q: query,
            fields: "files(name,id,createdTime,modifiedTime)"
        });
        return resp;
    }

    const p = new Promise(async (resolve, reject) => { 
        backoff(
            callback, 
            (resp) => { 
                resolve(resp.data.files);
            }, (err) => {
                reject(err);
            });
    });

    return p;
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

const tryToDeleteDocument = async (id) => {
    await drive.files.delete({fileId: id}, (err) => {
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

const doUpload = async (folderId, documentPath, pathParts, fileStat) => {
    const source = uploadStatus.sourceDir;
    const relPath = (source.endsWith('/')) ? documentPath.substring(source.length) : documentPath.substring(source.length+1);
    const fileSize = fileStat.size;
    const fileName = pathParts[pathParts.length-1]; 
    const contentType = mime.lookup(fileName);
    const formatedSize = formatFileSize(fileSize);
    const parentId = (pathParts.length > 1) ? await getOrCreateFolderByPath(folderId, pathParts.slice(0, pathParts.length-1)) : folderId;
    
    switch (uploadStatus.mode) {
        case MODES.uploadAll:
            try {
                await tryToUploadDocument(parentId, documentPath, fileName, fileSize);
            } catch (err) {
                console.log(`Unable to upload document ${documentPath}. Time ${updateTimer()}.`, err);
                report(relPath, 'error', formatedSize, `Unable to upload: ${err.message}`);
            }
            uploadStatus.fileCount += 1;
            console.log(`${uploadStatus.fileCount}. ${documentPath} (${formatedSize}) finished. Time ${updateTimer()}.`);
            break;  
        case MODES.keepRemote: 
            try {
                let allFiles = await getGoogleFilesByName(folderId, fileName);
                allFiles = allFiles.concat(await getGoogleFilesByName(folderId, fileName.split('.')[0]));
                if (allFiles.length === 0) {
                    try {
                        await tryToUploadDocument(parentId, documentPath, fileName, fileSize);
                    } catch (err) {
                        console.log(`Unable to upload document ${documentPath}. Time ${updateTimer()}.`, err);
                        report(relPath, 'error', formatedSize, `Unable to upload: ${err.message}`);
                    }
                    uploadStatus.fileCount += 1;
                    console.log(`${uploadStatus.fileCount}. ${documentPath} (${formatedSize}) finished. Time ${updateTimer()}.`);
                } else {
                    report(relPath, 'skipped', formatedSize, `File exists on Google Drive`);
                    uploadStatus.processing -= 1;
                }
            } catch (err) {
                console.log(`Unable to upload document ${documentPath}. Time ${updateTimer()}.`, err);
                report(relPath, 'error', formatedSize, `Unable to upload: ${err.message}`);
                uploadStatus.processing -= 1;
            }
            break;
        case MODES.overwrite:
            try {
                let files = await getGoogleFilesByName(folderId, fileName);
                files = files.concat(await getGoogleFilesByName(folderId, fileName.split('.')[0]));
                for (const file of files) {
                    console.log(`Deleting file ${file.name}. Modified ${Date.parse(file.modifiedTime)}. Local Moddified ${fileStat.mtimeMs}`);
                    try {
                        await tryToDeleteDocument(file.id);
                        report(relPath, 'deleted', formatedSize, `Google Drive file '${file.name}' deleted to overwrite.`);
                    } catch (err) {
                        console.log(`Unable to delete Google Drive file ${file.name}. ${err.message}`);
                        report(relPath, 'error', formatedSize, `Unable to delete Google Drive file ${file.name}. ${err.message}`);
                    }
                }

                try {
                    await tryToUploadDocument(parentId, documentPath, fileName, fileSize);
                } catch (err) {
                    console.log(`Unable to upload document ${documentPath}. Time ${updateTimer()}.`, err);
                    report(relPath, 'error', formatedSize, `Unable to upload: ${err.message}`);
                }
                uploadStatus.fileCount += 1;
                console.log(`${uploadStatus.fileCount}. ${documentPath} (${formatedSize}) finished. Time ${updateTimer()}.`);
            } catch (err) {
                console.log(`Unable to upload document ${documentPath}. Time ${updateTimer()}.`, err);
                report(relPath, 'error', formatedSize, `Unable to upload: ${err.message}`);
                uploadStatus.processing -= 1;
            }
            break;
        case MODES.overwriteOlder:
            try {
                let files = await getGoogleFilesByName(folderId, fileName);
                files = files.concat(await getGoogleFilesByName(folderId, fileName.split('.')[0]));
                let deleted = false;
                for (const file of files) {
                    const gdLastModified = Date.parse(file.modifiedTime);
                    if (gdLastModified < fileStat.mtimeMs) {
                        console.log(`Deleting file ${file.name}. Modified ${gdLastModified}. Local Moddified ${fileStat.mtimeMs}`);
                        try {
                            await tryToDeleteDocument(file.id);
                            report(relPath, 'deleted', formatedSize, `Google Drive file '${file.name}' deleted to overwrite onlder file (modified ${file.modifiedTime}).`);
                            deleted = true;
                        } catch (err) {
                            console.log(`Unable to delete Google Drive file ${file.name}. ${err.message}`);
                            report(relPath, 'error', formatedSize, `Unable to delete Google Drive file ${file.name}. ${err.message}`);
                        }
                    }
                }

                if (deleted) {
                    try {
                        await tryToUploadDocument(parentId, documentPath, fileName, fileSize);
                    } catch (err) {
                        console.log(`Unable to upload document ${documentPath}. Time ${updateTimer()}.`, err);
                        report(relPath, 'error', formatedSize, `Unable to upload: ${err.message}`);
                        uploadStatus.processing -= 1;
                    }
                } else {
                    report(relPath, 'skipped', formatedSize, `Google Drive file is newer. Not uploading.`);
                    uploadStatus.processing -= 1;
                }
                uploadStatus.fileCount += 1;
                console.log(`${uploadStatus.fileCount}. ${documentPath} (${formatedSize}) finished. Time ${updateTimer()}.`);
            } catch (err) {
                console.log(`Unable to upload document ${documentPath}. Time ${updateTimer()}.`, err);
                report(relPath, 'error', formatedSize, `Unable to upload: ${err.message}`);
                uploadStatus.processing -= 1;
            }
            break;
        case MODES.convert:
            break;
        default: console.log('Mode');
    }  
}

const finish = async () => {
    if (uploadStatus.processing > 0) {
        // console.log(uploadStatus.processing);
        setTimeout(finish, 500);
    } else if (uploadStatus.mode !== MODES.scanonly) {
        console.log(`Saving upload report. Time ${updateTimer()}`);
        await ReportUtil.saveReport(uploadStatus, uploadStatus.sourceDir, 'upload-report', 'Upload Report', ['path', 'status', 'fileSize', 'message']);
        console.log(`Uploaded ${uploadStatus.fileCount} files in ${updateTimer()}.`);
    }
}

const handler = async (argv) => {
    driveAPI = new DriveAPI();
    driveAPI.init(argv.credentials, async (driveObj) => {
        console.log(`Ready to upload to folder '${argv.target}'!`);
        drive = driveObj;

        const source = absPath(argv.source);
        uploadStatus.mode = checkMode(argv);
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
            } else if (uploadStatus.mode !== MODES.scanonly && uploadStatus.mode !== MODES.convert && stats.isDirectory() && hasFiles(filePath)) {
                await getOrCreateFolderByPath(argv.target, relPath.split('/'));
                console.log(`Google Folder ${relPath} created. Time ${updateTimer()}`);
            }
        });

        const totalSizeFormatted = formatFileSize(uploadStatus.totalSizeUpload);
        console.log(`${entries.length} to upload. Total data to upload ${totalSizeFormatted}.`);

        if (uploadStatus.mode === MODES.convert) {
            console.log('Conveting Google Drive files to Google Documents.');
            await convertToGoogleDocsScan(argv.target);
            finish();
        } else if (entries.length > 0 && uploadStatus.mode !== MODES.scanonly) {
            const asyncCallback = async (filePath, options, index, array) => {
                return new Promise(async (resolve) => {
                    try {
                        const relPath = (source.endsWith('/')) ? filePath.substring(source.length) : filePath.substring(source.length+1);
                        let stat = fs.statSync(filePath);
                        console.log(`${index+1}/${entries.length}. Uploading ${filePath} ${formatFileSize(stat.size)}`)
                        uploadStatus.processing += 1;
                        await doUpload(argv.target, filePath, relPath.split('/'), stat);
                    } catch(err) {
                        console.log(`Unable to upload ${filePath}.`, err);
                        report(filePath, 'error', 0, `Unable to upload ${filePath}. ${err.message}`);
                    }
                    resolve();
                });
            }

            ConcurrencyUtil.processAll(entries, asyncCallback, {}, argv.async, 3000, true).then(async () => {
                if (uploadStatus.printTarget) {
                    await printRemoteFileListing(argv.target);
                }
                finish();
            });
        } else if (uploadStatus.printTarget) {
            console.log('Printing Google Drive file listing.');
            await printRemoteFileListing(argv.target);
        }
    });
};

export default {
    command,
    desc,
    builder,
    handler
}