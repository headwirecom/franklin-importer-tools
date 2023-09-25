import Path, { resolve } from 'path';

const absPath = (path) => {
    if (path.startsWith('/')) {
        return path;
    } else {
        const cwd = process.cwd();
        const absPath = Path.join(process.cwd(), path);
        return absPath;
    }
};

export {
    absPath
}