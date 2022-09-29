import process from 'node:process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as child_process from 'node:child_process';
import * as util from 'node:util';
import createDebug from 'debug';

const exec = util.promisify(child_process.exec);

const debug = createDebug('nxapi:util:product');

//
// Package/version info
//

export const dir = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf-8'));
export const version: string = pkg.version;
export const release: string | null = pkg.__nxapi_release ?? null;

export const git = await (async () => {
    try {
        await fs.stat(path.join(dir, '.git'));
    } catch (err) {
        return null;
    }

    const options: child_process.ExecOptions = {cwd: dir};
    const [revision, branch, changed_files] = await Promise.all([
        exec('git rev-parse HEAD', options).then(({stdout}) => stdout.toString().trim()),
        exec('git rev-parse --abbrev-ref HEAD', options).then(({stdout}) => stdout.toString().trim()),
        exec('git diff --name-only HEAD', options).then(({stdout}) => stdout.toString().trim()),
    ]);

    return {
        revision,
        branch: branch && branch !== 'HEAD' ? branch : null,
        changed_files: changed_files.length ? changed_files.split('\n') : [],
    };
})();

export const dev = process.env.NODE_ENV !== 'production' &&
    (!!git || process.env.NODE_ENV === 'development');

export const product = 'nxapi-znca-api ' + version +
    (!release && git ? '-' + git.revision.substr(0, 7) + (git.branch ? ' (' + git.branch + ')' : '') : '');
