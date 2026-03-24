import {
  EC2Client,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  ImagebuilderClient,
  SendWorkflowStepActionCommand,
} from '@aws-sdk/client-imagebuilder';

export interface WaitForActionPayload {
  workflowStepExecutionId: string;
  imageArn: string;
  stepOutputs?: {
    GetBuildInstance?: { reason?: string };
  };
  [key: string]: unknown;
}

const ec2 = new EC2Client({});
const imagebuilder = new ImagebuilderClient({});

export async function handler(event: WaitForActionPayload): Promise<void> {
  console.log(JSON.stringify(event));

  if (!event.workflowStepExecutionId) return;

  const { workflowStepExecutionId: stepId, imageArn } = event;
  const instanceId = event.stepOutputs?.GetBuildInstance?.reason;

  try {
    if (instanceId) {
      await ec2.send(new TerminateInstancesCommand({
        InstanceIds: [instanceId],
      }));
      console.log(`Terminated instance ${instanceId}`);
    }

    await imagebuilder.send(new SendWorkflowStepActionCommand({
      stepExecutionId: stepId,
      imageBuildVersionArn: imageArn,
      action: 'RESUME',
      reason: instanceId ?? 'no-instance',
    }));
  } catch (err) {
    console.error('Error terminating instance:', err);
    try {
      await imagebuilder.send(new SendWorkflowStepActionCommand({
        stepExecutionId: stepId,
        imageBuildVersionArn: imageArn,
        action: 'STOP',
        reason: `Termination error: ${String(err)}`.slice(0, 200),
      }));
    } catch (stopErr) {
      console.error('Failed to send STOP action:', stopErr);
    }
    throw err;
  }
}
