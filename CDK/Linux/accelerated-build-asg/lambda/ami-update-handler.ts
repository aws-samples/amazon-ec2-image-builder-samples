import {
  EC2Client,
  CreateLaunchTemplateVersionCommand,
  ModifyLaunchTemplateCommand,
} from '@aws-sdk/client-ec2';
import {
  AutoScalingClient,
  UpdateAutoScalingGroupCommand,
  StartInstanceRefreshCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  SSMClient,
  GetParameterCommand,
} from '@aws-sdk/client-ssm';

const ec2 = new EC2Client({});
const asg = new AutoScalingClient({});
const ssm = new SSMClient({});

const LAUNCH_TEMPLATE_ID = process.env.LAUNCH_TEMPLATE_ID!;
const ASG_NAME = process.env.ASG_NAME!;
const SSM_PARAMETER = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64';

export async function handler(): Promise<{ statusCode: number; body: string }> {
  const paramResp = await ssm.send(new GetParameterCommand({ Name: SSM_PARAMETER }));
  const latestAmiId = paramResp.Parameter!.Value!;

  const versionResp = await ec2.send(new CreateLaunchTemplateVersionCommand({
    LaunchTemplateId: LAUNCH_TEMPLATE_ID,
    SourceVersion: '$Latest',
    VersionDescription: 'Auto-updated with latest Amazon Linux 2023 AMI',
    LaunchTemplateData: { ImageId: latestAmiId },
  }));
  const newVersion = versionResp.LaunchTemplateVersion!.VersionNumber!;

  await ec2.send(new ModifyLaunchTemplateCommand({
    LaunchTemplateId: LAUNCH_TEMPLATE_ID,
    DefaultVersion: String(newVersion),
  }));

  await asg.send(new UpdateAutoScalingGroupCommand({
    AutoScalingGroupName: ASG_NAME,
    LaunchTemplate: {
      LaunchTemplateId: LAUNCH_TEMPLATE_ID,
      Version: '$Latest',
    },
  }));

  await asg.send(new StartInstanceRefreshCommand({
    AutoScalingGroupName: ASG_NAME,
    Strategy: 'Rolling',
    Preferences: { MinHealthyPercentage: 0 },
  }));

  console.log(`Updated Launch Template to version ${newVersion} with AMI ${latestAmiId}`);
  return { statusCode: 200, body: `Updated to version ${newVersion} with AMI ${latestAmiId}` };
}
