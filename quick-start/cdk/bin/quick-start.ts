#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { QuickStartStack } from '../lib/quick-start-stack';

const app = new cdk.App();
// No env is set: the stack uses only region-agnostic references, so it
// synthesizes without credentials and deploys to the CLI's default account
// and region.
new QuickStartStack(app, 'ImageBuilderQuickStartStack', {
  description:
    'EC2 Image Builder quick start: a complete, minimal image pipeline for Amazon Linux 2023',
});
