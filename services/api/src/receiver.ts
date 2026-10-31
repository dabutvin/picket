/**
 * Camera-facing settings, managed from the app: the FTPS host/user/password the
 * a7C II needs, password rotation (pushed to the receiver over SSM), and
 * start/stop of the receiver instance.
 */
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetCommandInvocationCommand, SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm';
import { DescribeInstancesCommand, EC2Client, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { randomInt } from 'node:crypto';
import type { ReceiverPowerAction, ReceiverSettings } from './types.js';

export interface ReceiverConfig {
  host: string;
  user: string;
  passiveMin: number;
  passiveMax: number;
  passwordSecretId: string;
  instanceId: string;
}

/** The AWS surface, kept narrow so tests can fake it. */
export interface ReceiverCloud {
  getPassword(): Promise<string>;
  setPassword(value: string): Promise<void>;
  runReloadCommand(): Promise<'Success' | 'Pending' | 'Failed'>;
  instanceState(): Promise<string>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Letters and digits only: the camera's on-screen keyboard is slow for symbols. */
export const PASSWORD_RULE = /^[A-Za-z0-9]{8,64}$/;

export function generatePassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // no 0/O/1/l/I
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function createReceiverCloud(cfg: ReceiverConfig, clients?: { sm?: SecretsManagerClient; ssm?: SSMClient; ec2?: EC2Client }): ReceiverCloud {
  const sm = clients?.sm ?? new SecretsManagerClient({});
  const ssm = clients?.ssm ?? new SSMClient({});
  const ec2 = clients?.ec2 ?? new EC2Client({});
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    async getPassword() {
      const res = await sm.send(new GetSecretValueCommand({ SecretId: cfg.passwordSecretId }));
      return res.SecretString ?? '';
    },
    async setPassword(value) {
      await sm.send(new PutSecretValueCommand({ SecretId: cfg.passwordSecretId, SecretString: value }));
    },
    async runReloadCommand() {
      const sent = await ssm.send(
        new SendCommandCommand({
          InstanceIds: [cfg.instanceId],
          DocumentName: 'AWS-RunShellScript',
          Comment: 'picket: reload ftp password',
          Parameters: { commands: ['/usr/local/bin/picket-set-ftp-password.sh'] },
        }),
      );
      const id = sent.Command?.CommandId;
      if (!id) return 'Failed';
      // Usually done in a few seconds; stay well inside the Lambda timeout.
      for (let i = 0; i < 8; i++) {
        await sleep(1500);
        try {
          const inv = await ssm.send(new GetCommandInvocationCommand({ CommandId: id, InstanceId: cfg.instanceId }));
          if (inv.Status === 'Success') return 'Success';
          if (inv.Status === 'Failed' || inv.Status === 'Cancelled' || inv.Status === 'TimedOut') return 'Failed';
        } catch {
          /* invocation not registered yet */
        }
      }
      return 'Pending';
    },
    async instanceState() {
      const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [cfg.instanceId] }));
      return res.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? 'unknown';
    },
    async start() {
      await ec2.send(new StartInstancesCommand({ InstanceIds: [cfg.instanceId] }));
    },
    async stop() {
      await ec2.send(new StopInstancesCommand({ InstanceIds: [cfg.instanceId] }));
    },
  };
}

export function createReceiverService(cfg: ReceiverConfig, cloud: ReceiverCloud) {
  async function settings(reload?: ReceiverSettings['passwordReload']): Promise<ReceiverSettings> {
    const [password, instanceState] = await Promise.all([cloud.getPassword(), cloud.instanceState()]);
    return {
      host: cfg.host,
      port: 21,
      user: cfg.user,
      password,
      secureProtocol: true,
      passiveMode: true,
      passivePorts: `${cfg.passiveMin}-${cfg.passiveMax}`,
      instanceState,
      ...(reload ? { passwordReload: reload } : {}),
    };
  }

  return {
    get: () => settings(),

    /** Set a chosen password or generate one, then make the receiver pick it up. */
    async rotatePassword(requested?: string): Promise<ReceiverSettings> {
      const next = requested ?? generatePassword();
      if (!PASSWORD_RULE.test(next)) throw new BadPassword();
      await cloud.setPassword(next);
      const state = await cloud.instanceState();
      // A stopped receiver reads the secret at next boot; nothing to reload.
      const reload = state === 'running' ? await cloud.runReloadCommand() : 'Success';
      return settings(reload === 'Success' ? 'applied' : reload === 'Pending' ? 'pending' : 'failed');
    },

    async power(action: ReceiverPowerAction): Promise<ReceiverSettings> {
      if (action === 'start') await cloud.start();
      else await cloud.stop();
      return settings();
    },
  };
}

export class BadPassword extends Error {
  constructor() {
    super('password must be 8-64 letters and digits');
  }
}
