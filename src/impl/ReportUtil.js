import ExcelJS from 'exceljs';
import Path, { resolve } from 'path';
import fs from 'fs-extra';

const writeReportWorksheet = (worksheet, reporStatus, defaultHeaders) => {
    const headers = [...defaultHeaders].concat(reporStatus.extraCols);

    // create Excel auto Filters for the first row / header
    worksheet.autoFilter = {
        from: 'A1',
        to: `${String.fromCharCode(65 + headers.length - 1)}1`, // 65 = 'A'...
    };

    worksheet.addRows([
        headers,
    ].concat(reporStatus.rows.map((row) => {
        const {
            url, path, file, status, redirect, report,
        } = row;
        const extra = [];
        if (report) {
            reporStatus.extraCols.forEach((col) => {
                const e = report[col];
                if (e) {
                    if (typeof e === 'string') {
                        if (e.startsWith('=')) {
                            extra.push({
                                formula: report[col].replace(/=/, '_xlfn.'),
                                value: '', // cannot compute a default value
                            });
                        } else {
                            extra.push(report[col]);
                        }
                    } else {
                        extra.push(JSON.stringify(report[col]));
                    }
                }
            });
        }

        return [url, path, file || '', status, redirect || ''].concat(extra);
    })));
}

const buildReport = async (reporStatus, filePath, worksheetName, defaultHeaders, concatenate = true) => {
    const workbook = new ExcelJS.Workbook();
    let worksheet = null;
    if (concatenate && fs.existsSync(filePath)) {
        workbook.xlsx.readFile(filePath).then(() => {
            worksheet = workbook.getWorksheet(worksheetName);
            if (!worksheet) {
                worksheet = workbook.addWorksheet(worksheetName);
            }
            writeReportWorksheet(worksheet, reporStatus, defaultHeaders);
            workbook.xlsx.writeFile(filePath);
        }).catch((error) => {
            console.error(`Unable to save ${worksheetName} report ${filePath}`, error);
        });
    } else {
        worksheet = workbook.addWorksheet(worksheetName);
        writeReportWorksheet(worksheet, reporStatus, defaultHeaders);
        workbook.xlsx.writeFile(filePath);
    }
};

const whatFileName = (targetDir, suggestedName, concatenate) => {
    let name = suggestedName;
    let count = 0;
    if (!concatenate) {
        const ls = fs.readdirSync(targetDir);
        ls.forEach((file) => {
            if (file.endsWith('.xlsx') && (file.startsWith(`${name}.`) || file.startsWith(`${name}-`))) {
                count = count + 1;
            }
        });

        if (count > 0) {
            name = `${suggestedName}-${count+1}`;
        }
    }
    return name;
};

export default class ReportUtil {
    static async saveReport(reportStatus, targetDir, reportName, 
        worksheetName = 'Import Status', 
        defaultHeaders = ['URL', 'path', 'file', 'status', 'redirect'], 
        concatenate = true) {
        const name = whatFileName(targetDir, reportName, concatenate);
        const reportFilePath = Path.join(targetDir,`${name}.xlsx`);
        try {
            await buildReport(reportStatus, reportFilePath, worksheetName, defaultHeaders, concatenate);
        } catch (error) {
            console.error(`Unable to save import report ${reportFilePath}`, error);
        }
    };
}