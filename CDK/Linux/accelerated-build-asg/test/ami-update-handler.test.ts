const mockSend = jest.fn();

jest.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn(() => ({ send: (...args: unknown[]) => mockSend(...args) })),
  CreateLaunchTemplateVersionCommand: jest.fn((input) => ({ _type: 'CreateLaunchTemplateVersion', input })),
  ModifyLaunchTemplateCommand: jest.fn((input) => ({ _type: 'ModifyLaunchTemplate', input })),
}));
jest.mock('@aws-sdk/client-auto-scaling', () => ({
  AutoScalingClient: jest.fn(() => ({ send: (...args: unknown[]) => mockSend(...args) })),
  UpdateAutoScalingGroupCommand: jest.fn((input) => ({ _type: 'UpdateAutoScalingGroup', input })),
  StartInstanceRefreshCommand: jest.fn((input) => ({ _type: 'StartInstanceRefresh', input })),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: (...args: unknown[]) => mockSend(...args) })),
  GetParameterCommand: jest.fn((input) => ({ _type: 'GetParameter', input })),
}));

import { handler } from '../lambda/ami-update-handler';

process.env.LAUNCH_TEMPLATE_ID = 'lt-test123';
process.env.ASG_NAME = 'test-asg';

beforeEach(() => {
  mockSend.mockReset();
  jest.spyOn(console, 'log').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ami-update-handler', () => {
  test('happy path: creates new LT version, sets default, refreshes ASG', async () => {
    mockSend
      .mockResolvedValueOnce({ Parameter: { Value: 'ami-newlatest' } })
      .mockResolvedValueOnce({ LaunchTemplateVersion: { VersionNumber: 5 } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await handler();

    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('version 5');
    expect(result.body).toContain('ami-newlatest');

    const createCall = mockSend.mock.calls[1][0];
    expect(createCall.input.LaunchTemplateData.ImageId).toBe('ami-newlatest');

    const modifyCall = mockSend.mock.calls[2][0];
    expect(modifyCall.input.DefaultVersion).toBe('5');

    expect(mockSend).toHaveBeenCalledTimes(5);
  });

  test('SSM parameter fetch failure throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('Parameter not found'));
    await expect(handler()).rejects.toThrow('Parameter not found');
  });

  test('CreateLaunchTemplateVersion failure throws', async () => {
    mockSend
      .mockResolvedValueOnce({ Parameter: { Value: 'ami-newlatest' } })
      .mockRejectedValueOnce(new Error('LT version failed'));
    await expect(handler()).rejects.toThrow('LT version failed');
  });
});
