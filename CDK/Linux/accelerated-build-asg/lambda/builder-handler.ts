import {
  AutoScalingClient,
  DetachInstancesCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  EC2Client,
  DescribeInstancesCommand,
  CreateTagsCommand,
} from '@aws-sdk/client-ec2';
import {
  ImagebuilderClient,
  SendWorkflowStepActionCommand,
} from '@aws-sdk/client-imagebuilder';
import {
  SSMClient,
  DescribeInstanceInformationCommand,
} from '@aws-sdk/client-ssm';
import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';

export interface WaitForActionPayload {
  workflowStepExecutionId: string;
  imageArn: string;
  [key: string]: unknown;
}

const asg = new AutoScalingClient({});
const ec2 = new EC2Client({});
const imagebuilder = new ImagebuilderClient({});
const ssm = new SSMClient({});
const ddb = new DynamoDBClient({});

const ASG_NAME = process.env.ASG_NAME!;
const LOCK_TABLE_NAME = process.env.LOCK_TABLE_NAME!;
const LOCK_TTL_SECONDS = 3600; // 1 hour

async function acquireLock(instanceId: string, imageArn: string): Promise<boolean> {
  const ttl = Math.floor(Date.now() / 1000) + LOCK_TTL_SECONDS;
  try {
    await ddb.send(new PutItemCommand({
      TableName: LOCK_TABLE_NAME,
      Item: {
        instanceId: { S: instanceId },
        imageArn: { S: imageArn },
        ttl: { N: String(ttl) },
      },
      ConditionExpression: 'attribute_not_exists(instanceId)',
    }));
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'name' in err && err.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
}

async function releaseLock(instanceId: string): Promise<void> {
  await ddb.send(new DeleteItemCommand({
    TableName: LOCK_TABLE_NAME,
    Key: { instanceId: { S: instanceId } },
  }));
}

async function findAndLockInstance(instanceIds: string[], imageArn: string): Promise<string | undefined> {
  for (const id of instanceIds) {
    const resp = await ssm.send(new DescribeInstanceInformationCommand({
      Filters: [
        { Key: 'InstanceIds', Values: [id] },
        { Key: 'PingStatus', Values: ['Online'] },
      ],
    }));
    if (!resp.InstanceInformationList?.[0]?.InstanceId) continue;

    if (await acquireLock(id, imageArn)) return id;
    console.log(`Instance ${id} already locked, trying next`);
  }
  return undefined;
}

async function sendStop(stepExecutionId: string, imageArn: string, reason: string): Promise<void> {
  await imagebuilder.send(new SendWorkflowStepActionCommand({
    stepExecutionId,
    imageBuildVersionArn: imageArn,
    action: 'STOP',
    reason: reason.slice(0, 200),
  }));
}

export async function handler(event: WaitForActionPayload): Promise<void> {
  console.log(JSON.stringify(event));

  if (!event.workflowStepExecutionId) return;

  const { workflowStepExecutionId: stepId, imageArn } = event;
  const imageName = imageArn.split('/')[1];
  let lockedInstanceId: string | undefined;

  try {
    const instances = await ec2.send(new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:aws:autoscaling:groupName', Values: [ASG_NAME] },
        { Name: 'instance-state-name', Values: ['running'] },
      ],
    }));

    const runningIds = (instances.Reservations ?? [])
      .flatMap(r => r.Instances ?? [])
      .filter(i => i.State?.Name === 'running' && i.InstanceId)
      .map(i => i.InstanceId!);

    lockedInstanceId = await findAndLockInstance(runningIds, imageArn);

    if (!lockedInstanceId) {
      console.log(`No suitable instance found for image ${imageArn}`);
      await sendStop(stepId, imageArn, 'No suitable instance found in ASG');
      return;
    }

    await asg.send(new DetachInstancesCommand({
      AutoScalingGroupName: ASG_NAME,
      InstanceIds: [lockedInstanceId],
      ShouldDecrementDesiredCapacity: false,
    }));

    await ec2.send(new CreateTagsCommand({
      Resources: [lockedInstanceId],
      Tags: [
        { Key: 'Name', Value: `Build instance for ${imageName}` },
        { Key: 'CreatedBy', Value: 'EC2 Image Builder' },
        { Key: 'Ec2ImageBuilderArn', Value: imageArn },
      ],
    }));

    await imagebuilder.send(new SendWorkflowStepActionCommand({
      stepExecutionId: stepId,
      imageBuildVersionArn: imageArn,
      action: 'RESUME',
      reason: lockedInstanceId,
    }));
  } catch (err) {
    console.error('Error processing event:', err);
    if (lockedInstanceId) {
      try { await releaseLock(lockedInstanceId); } catch (e) { console.error('Failed to release lock:', e); }
    }
    try {
      await sendStop(stepId, imageArn, `Lambda error: ${String(err)}`);
    } catch (stopErr) {
      console.error('Failed to send STOP action:', stopErr);
    }
    throw err;
  }
}
