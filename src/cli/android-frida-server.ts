import process from 'node:process';
import * as net from 'node:net';
import * as dns from 'node:dns/promises';
import createDebug from 'debug';
import Server from '../android-frida-server/server.js';
import { AndroidDeviceManager, AndroidDevicePool } from '../android-frida-server/device.js';
import { StartMethod } from '../android-frida-server/types.js';
import type { Arguments as ParentArguments } from './index.js';
import { ArgumentsCamelCase, Argv, YargsArguments } from '../util/yargs.js';
import { parseListenAddress } from '../util/net.js';
import MetricsCollector from '../android-frida-server/metrics.js';
import { initStorage, paths } from '../util/storage.js';
import { UserData1, UserData2 } from '../android-frida-server/frida-script.cjs';

const debug = createDebug('cli:android-frida-server');

export const command = 'android-frida-server <device>';
export const desc = 'Connect to a rooted Android device with frida-server over ADB running the Nintendo Switch Online app and start a HTTP server to generate f parameters';

export function builder(yargs: Argv<ParentArguments>) {
    return yargs.positional('device', {
        describe: 'ADB server address/port',
        type: 'string',
        demandOption: true,
    }).option('exec-command', {
        describe: 'Command to use to run a file on the device',
        type: 'string',
    }).option('adb-path', {
        describe: 'Path to the adb executable',
        type: 'string',
    }).option('adb-root', {
        describe: 'Run `adb root` to restart adbd as root',
        type: 'boolean',
        default: false,
    }).option('frida-server-path', {
        describe: 'Path to the frida-server executable on the device',
        type: 'string',
        default: '/data/local/tmp/frida-server',
    }).option('start-method', {
        describe: 'Method to ensure the app is running (one of "spawn", "none", "activity", "service")',
        type: 'string',
        default: 'service',
    }).option('strict-validate', {
        describe: 'Validate data exactly matches the format that would be generated by Nintendo\'s Android app',
        type: 'boolean',
        default: false,
    }).option('validate-tokens', {
        describe: 'Validate tokens before passing them to znca',
        type: 'boolean',
        default: true,
    }).option('rate-limit', {
        describe: 'Per-user rate limit (requests/period_ms)',
        type: 'string',
    }).option('rate-limit-webservice', {
        describe: 'Per-user rate limit (requests/period_ms)',
        type: 'string',
    }).option('resolve-multiple-devices', {
        type: 'boolean',
        default: false,
    }).option('metrics', {
        type: 'boolean',
        default: false,
    }).option('listen', {
        describe: 'Server address and port',
        type: 'array',
        default: ['[::]:0'],
    });
}

type Arguments = YargsArguments<ReturnType<typeof builder>>;

export async function handler(argv: ArgumentsCamelCase<Arguments>) {
    const start_method =
        argv.startMethod === 'spawn' ? StartMethod.SPAWN :
        argv.startMethod === 'activity' ? StartMethod.ACTIVITY :
        argv.startMethod === 'service' ? StartMethod.SERVICE :
        argv.startMethod === 'force-activity' ? StartMethod.FORCE_ACTIVITY :
        argv.startMethod === 'force-service' ? StartMethod.FORCE_SERVICE :
        StartMethod.NONE;

    const metrics = argv.metrics ? new MetricsCollector() : null;

    const device_pool = new AndroidDevicePool(metrics);
    const devices = new Set<AndroidDeviceManager>();

    if (argv.resolveMultipleDevices) {
        // Automatically add multiple devices using the same hostname
        // This is intended to be used with scaled redroid containers
        // The server will check for updated containers every 1m
        // The server will not exit if any devices disconnect

        const updateDevices = async () => {
            const results = await dns.lookup(argv.device, {
                all: true,
            });

            debug('Updating devices', results);

            const device_names = [];

            for (const result of results) {
                const device_name = result.family === 6 ?
                    '[' + result.address + ']:5555' : result.address + ':5555';

                device_names.push(device_name);
                if ([...devices].find(d => d.device_name === device_name)) continue;

                debug('Adding device %s', device_name);

                try {
                    const device = await AndroidDeviceManager.create(
                        device_pool,
                        device_name,
                        argv.adbPath,
                        argv.adbRoot,
                        argv.execCommand,
                        argv.fridaServerPath,
                        start_method,
                    );

                    device.onReattachFailed = () => {
                        setTimeout(() => device.reattach(), 1000);
                    };

                    devices.add(device);
                } catch (err) {
                    debug('Error adding device %s', device_name, err);

                    // Retry on next update
                }
            }

            for (const device of devices) {
                if (device_names.includes(device.device_name)) continue;

                debug('Removing device %s', device.device_name);
                device.destroy();
                devices.delete(device);
            }

            setTimeout(updateDevices, 30 * 1000).unref();
        };

        await updateDevices();
    } else {
        // Standard device connection mode - one server per device connection
        // The server will not start until the device is connected
        // If the device disconnects, the server will exit if it is unable to reconnect

        const device = await AndroidDeviceManager.create(
            device_pool,
            argv.device,
            argv.adbPath,
            argv.adbRoot,
            argv.execCommand,
            argv.fridaServerPath,
            start_method,
        );

        device.onReattachFailed = () => {
            console.error('Failed to reattach to the Android device, exiting');
            process.exit(1);
        };

        devices.add(device);
    }

    const server = new Server(device_pool, metrics);
    server.validate_tokens = argv.validateTokens;
    server.strict_validate = argv.strictValidate;

    server.storage = await initStorage(process.env.NXAPI_DATA_PATH ?? paths.data);

    if (argv.rateLimit) {
        const match = argv.rateLimit.match(/(\d+)\/(\d+)/);
        if (!match) throw new Error('Invalid --rate-limit value');

        server.limits_coral = [parseInt(match[1]), parseInt(match[2]) * 1000];
        server.limits_webservice = server.limits_coral;
    }
    if (argv.rateLimitWebservice) {
        const match = argv.rateLimitWebservice.match(/(\d+)\/(\d+)/);
        if (!match) throw new Error('Invalid --rate-limit-webservice value');

        server.limits_webservice = [parseInt(match[1]), parseInt(match[2]) * 1000];
    }

    debug('coral auth rate limit', server.limits_coral);
    debug('web service auth rate limit', server.limits_webservice);

    const onexit = (code: number | NodeJS.Signals) => {
        process.removeListener('exit', onexit);
        process.removeListener('SIGTERM', onexit);
        process.removeListener('SIGINT', onexit);

        debug('Exiting', code);
        console.log('Exiting', code);

        for (const device of devices) {
            device.destroy();
        }

        process.exit(typeof code === 'number' ? code : 0);
    };

    process.on('exit', onexit);
    process.on('SIGTERM', onexit);
    process.on('SIGINT', onexit);

    const app = server.app;

    for (const address of argv.listen) {
        const [host, port] = parseListenAddress(address);
        const server = app.listen(port, host ?? '::');
        server.on('listening', () => {
            const address = server.address() as net.AddressInfo;
            console.log('Listening on %s, port %d', address.address, address.port);
        });
    }

    setInterval(async () => {
        await device_pool.ping();
    }, 5000);

    try {
        debug('Test gen_audio_h');
        const result = await device_pool.callWithDevice(device => {
            return device.api.genAudioH('id_token', 'timestamp', 'request_id');
        });
        debug('Test returned', result);
        debug('Test gen_audio_h2');
        const result_2 = await device_pool.callWithDevice(device => {
            return device.api.genAudioH2('id_token', 'timestamp', 'request_id');
        });
        debug('Test returned', result_2);

        const user_data: UserData1 & UserData2 = {
            na_id: '0000000000000000',
            na_id_token: 'id_token',
            coral_user_id: '0',
            coral_token: 'id_token',
        };

        debug('Test gen_audio_h with user data', user_data);
        const result_3 = await device_pool.callWithDevice(device => {
            return device.api.genAudioH('id_token', 'timestamp', 'request_id', user_data);
        });
        debug('Test returned', result_3);
        debug('Test gen_audio_h2 with user data');
        const result_4 = await device_pool.callWithDevice(device => {
            return device.api.genAudioH2('id_token', 'timestamp', 'request_id', user_data);
        });
        debug('Test returned', result_4);
    } catch (err) {
        debug('Test failed', err);
    }
}
