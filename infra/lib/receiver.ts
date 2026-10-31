import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface ReceiverProps {
  bucket: s3.IBucket;
  rawPrefix: string;
  /** FTP username the camera logs in with. */
  ftpUser?: string;
  /** Passive-mode data port range opened on the security group. */
  passivePorts?: { min: number; max: number };
  instanceType?: ec2.InstanceType;
  /** When set, an A record `<hostName>` is created in `zone` and the receiver gets a Let's Encrypt certificate for it. */
  dns?: { zone: route53.IHostedZone; hostName: string };
}

/**
 * The thing the camera talks to: a tiny arm64 instance running pure-ftpd with
 * TLS required, on a fixed public IP, that forwards every completed upload to
 * S3 and keeps nothing. See docs/DECISIONS.md ADR-001.
 */
export class Receiver extends Construct {
  readonly publicIp: string;
  /** What the camera should use as Host Name: the DNS name when configured, else the IP. */
  readonly hostName: string;
  readonly ftpUser: string;
  readonly ftpPassword: secretsmanager.Secret;
  readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: ReceiverProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    this.ftpUser = props.ftpUser ?? 'camera';
    const pasv = props.passivePorts ?? { min: 30000, max: 30009 };

    // Public-only VPC: one subnet, no NAT, nothing that costs money while idle.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const sg = new ec2.SecurityGroup(this, 'Sg', {
      vpc,
      description: 'Picket FTPS receiver',
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(21), 'FTP control (TLS required)');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcpRange(pasv.min, pasv.max), 'FTP passive data');
    if (props.dns) sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "Let's Encrypt HTTP-01 challenge");
    // No SSH. Use Session Manager: aws ssm start-session --target <instance-id>

    // The camera's password. Letters and digits only so it's easy to type on the camera.
    this.ftpPassword = new secretsmanager.Secret(this, 'FtpPassword', {
      description: 'Picket: FTP password the camera uses',
      generateSecretString: { excludePunctuation: true, includeSpace: false, passwordLength: 20 },
    });

    const eip = new ec2.CfnEIP(this, 'Eip', { domain: 'vpc' });
    this.publicIp = eip.attrPublicIp;
    this.hostName = props.dns?.hostName ?? this.publicIp;
    if (props.dns) {
      new route53.ARecord(this, 'DnsRecord', {
        zone: props.dns.zone,
        recordName: props.dns.hostName,
        target: route53.RecordTarget.fromIpAddresses(this.publicIp),
        ttl: cdk.Duration.minutes(5),
      });
    }

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    props.bucket.grantPut(role, `${props.rawPrefix}*`);
    this.ftpPassword.grantRead(role);

    const userData = ec2.UserData.custom(
      renderTemplate(path.join(__dirname, '..', 'ingest', 'cloud-init.sh'), {
        BUCKET: props.bucket.bucketName,
        RAW_PREFIX: props.rawPrefix,
        REGION: stack.region,
        PUBLIC_IP: this.publicIp,
        HOST_NAME: props.dns?.hostName ?? '',
        FTP_USER: this.ftpUser,
        FTP_SECRET_ARN: this.ftpPassword.secretArn,
        PASV_MIN: String(pasv.min),
        PASV_MAX: String(pasv.max),
        UPLOAD_SCRIPT: fs.readFileSync(path.join(__dirname, '..', 'ingest', 'upload-to-s3.sh'), 'utf8'),
        SWEEP_SCRIPT: fs.readFileSync(path.join(__dirname, '..', 'ingest', 'sweep.sh'), 'utf8'),
      }),
    );

    this.instance = new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: props.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id',
        { os: ec2.OperatingSystemType.LINUX, userData },
      ),
      securityGroup: sg,
      role,
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(8, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }),
        },
      ],
      requireImdsv2: true,
      userDataCausesReplacement: true,
    });
    // Workflows find the receiver by this tag (ops.yml, deploy.yml).
    cdk.Tags.of(this.instance).add('picket:role', 'receiver');

    new ec2.CfnEIPAssociation(this, 'EipAssoc', {
      allocationId: eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    });
  }
}

/** Replace `__KEY__` tokens in a text file. Values may be CDK tokens; they resolve at deploy. */
function renderTemplate(file: string, vars: Record<string, string>): string {
  let text = fs.readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    text = text.split(`__${k}__`).join(v);
  }
  const leftover = text.match(/__[A-Z_]+__/g);
  if (leftover) throw new Error(`Unrendered placeholders in ${file}: ${leftover.join(', ')}`);
  return text;
}
