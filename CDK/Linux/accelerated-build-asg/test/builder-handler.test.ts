const mockSend = jest.fn();

jest.mock('@aws-sdk/client-auto-scaling', () => ({
  AutoScalingClient: jest.fn(() => ({ send: (...args: unknown[]) => mockSend(...args) })),
  DetachInstancesCommand: jest.fn((input) => ({ _type: 'DetachInstances', input })),
}));
jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send: (...args: unknown[]) => mockSend(...args) })),
  DescribeInstancesCommand: jest.fn((input) => ({ _type: 'DescribeInstances', input })),
  CreateTagsCommand: jest.fn((input) => ({ _type: 'CreateTags', input })),
}));
jest.mock('@aws-sdk/client-imagebuilder', () => ({
  ImagebuilderClient: jest.fn(() => ({ send: (...args: unknown[]) => mockSend(...args) })),
  SendWorkflowStepActionCommand: jest.fn((input) => ({ _type: 'SendWorkflowStepAction', input })),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: (...args: unknown[]) => mockSend(...args) })),
  DescribeInstanceInformationCommand: jest.fn((input) => ({ _type: 'DescribeInstanceInformation', input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: (...args: unknown[]) => mockSend(...args) })),
  PutItemCommand: jest.fn((input) => ({ _type: 'PutItem', input })),
  DeleteItemCommand: jest.fn((input) => ({ _type: 'DeleteItem', input })),
}));

import { handler, WaitForActionPayload } from '../lambda/builder-handler';

process.env.ASG_NAME = 'test-asg';
process.env.LOCK_TABLE_NAME = 'test-lock-table';

const baseEvent: WaitForActionPayload = {
  workflowStepExecutionId: 'step-123',
  imageArn: 'arn:aws:imagebuilder:us-east-1:123456789012:image/my-image/1.0.0',
};

beforeEach(() => {
  mockSend.mockReset();
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('builder-handler', () => {
  test('happy path: finds instance, acquires lock, detaches, tags, sends RESUME', async () => {
    mockSend
      .mockResolvedValueOnce({ // DescribeInstances
        Reservations: [{ Instances: [{ InstanceId: 'i-abc123', State: { Name: 'running' } }] }],
      })
      .mockResolvedValueOnce({ // DescribeInstanceInformation
        InstanceInformationList: [{ InstanceId: 'i-abc123' }],
      })
      .mockResolvedValueOnce({}) // PutItem (lock acquired)
      .mockResolvedValueOnce({}) // DetachInstances
      .mockResolvedValueOnce({}) // CreateTags
      .mockResolvedValueOnce({}); // SendWorkflowStepAction RESUME

    await handler(baseEvent);

    // Verify lock was acquired
    const lockCall = mockSend.mock.calls[2][0];
    expect(lockCall._type).toBe('PutItem');
    expect(lockCall.input.Item.instanceId.S).toBe('i-abc123');
    expect(lockCall.input.ConditionExpression).toBe('attribute_not_exists(instanceId)');

    // Verify RESUME sent
    const resumeCall = mockSend.mock.calls[5][0];
    expect(resumeCall.input.action).toBe('RESUME');
    expect(resumeCall.input.reason).toBe('i-abc123');
  });

  test('lock contention skips to next instance', async () => {
    const conditionError = new Error('Condition not met');
    conditionError.name = 'ConditionalCheckFailedException';

    mockSend
      .mockResolvedValueOnce({ // DescribeInstances
        Reservations: [{
          Instances: [
            { InstanceId: 'i-locked', State: { Name: 'running' } },
            { InstanceId: 'i-free', State: { Name: 'running' } },
          ],
        }],
      })
      .mockResolvedValueOnce({ // SSM check i-locked: online
        InstanceInformationList: [{ InstanceId: 'i-locked' }],
      })
      .mockRejectedValueOnce(conditionError) // PutItem fails (i-locked already locked)
      .mockResolvedValueOnce({ // SSM check i-free: online
        InstanceInformationList: [{ InstanceId: 'i-free' }],
      })
      .mockResolvedValueOnce({}) // PutItem (lock acquired for i-free)
      .mockResolvedValueOnce({}) // DetachInstances
      .mockResolvedValueOnce({}) // CreateTags
      .mockResolvedValueOnce({}); // SendWorkflowStepAction RESUME

    await handler(baseEvent);

    const resumeCall = mockSend.mock.calls[7][0];
    expect(resumeCall.input.action).toBe('RESUME');
    expect(resumeCall.input.reason).toBe('i-free');
  });

  test('lock released on failure after acquisition', async () => {
    mockSend
      .mockResolvedValueOnce({ // DescribeInstances
        Reservations: [{ Instances: [{ InstanceId: 'i-abc123', State: { Name: 'running' } }] }],
      })
      .mockResolvedValueOnce({ // SSM online
        InstanceInformationList: [{ InstanceId: 'i-abc123' }],
      })
      .mockResolvedValueOnce({}) // PutItem (lock acquired)
      .mockRejectedValueOnce(new Error('Detach failed')) // DetachInstances fails
      .mockResolvedValueOnce({}) // DeleteItem (lock released)
      .mockResolvedValueOnce({}); // SendWorkflowStepAction STOP

    await expect(handler(baseEvent)).rejects.toThrow('Detach failed');

    // Verify lock was released
    const deleteCall = mockSend.mock.calls[4][0];
    expect(deleteCall._type).toBe('DeleteItem');
    expect(deleteCall.input.Key.instanceId.S).toBe('i-abc123');

    // Verify STOP sent
    const stopCall = mockSend.mock.calls[5][0];
    expect(stopCall.input.action).toBe('STOP');
  });

  test('no running instances sends STOP', async () => {
    mockSend
      .mockResolvedValueOnce({ Reservations: [] })
      .mockResolvedValueOnce({});

    await handler(baseEvent);

    const stopCall = mockSend.mock.calls[1][0];
    expect(stopCall.input.action).toBe('STOP');
    expect(stopCall.input.reason).toContain('No suitable instance');
  });

  test('instances exist but SSM offline sends STOP', async () => {
    mockSend
      .mockResolvedValueOnce({
        Reservations: [{ Instances: [{ InstanceId: 'i-offline', State: { Name: 'running' } }] }],
      })
      .mockResolvedValueOnce({ InstanceInformationList: [] })
      .mockResolvedValueOnce({});

    await handler(baseEvent);

    const stopCall = mockSend.mock.calls[2][0];
    expect(stopCall.input.action).toBe('STOP');
  });

  test('missing workflowStepExecutionId returns early', async () => {
    await handler({ workflowStepExecutionId: '', imageArn: '' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
