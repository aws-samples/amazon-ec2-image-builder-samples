#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { ParentInstanceAsgStack } from '../lib/parent-instance-asg-stack';

const app = new cdk.App();
// No env is set: the stack uses only region-agnostic references, so it
// synthesizes without credentials and deploys to the CLI's default account
// and region.
new ParentInstanceAsgStack(app, 'ImageBuilderParentInstanceAsgStack', {
  description:
    'EC2 Image Builder: build on a running instance taken from an Auto Scaling group',
});
