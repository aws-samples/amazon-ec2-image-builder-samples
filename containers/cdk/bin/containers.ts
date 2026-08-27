#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { ContainerStack } from '../lib/container-stack';

const app = new cdk.App();
// No env is set: the stack uses only region-agnostic references, so it
// synthesizes without credentials and deploys to the CLI's default account
// and region.
new ContainerStack(app, 'ImageBuilderContainerStack', {
  description:
    'EC2 Image Builder container pipeline: a weekly Amazon Linux 2023 base container image to ECR',
});
