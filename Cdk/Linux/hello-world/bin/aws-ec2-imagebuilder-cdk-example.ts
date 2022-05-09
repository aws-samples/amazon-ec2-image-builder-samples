#!/usr/bin/env node
import { App, Aws } from 'aws-cdk-lib';
import { ImageBuilderStack } from '../lib/aws-image-builder-stack';
const accountId = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const app = new App();
new ImageBuilderStack(app, 'ImageBuilderStack', {
    env: {
        account: app.node.tryGetContext('account') || accountId,
        region: app.node.tryGetContext('region') || region,
    },
    description: 'Sample stack to configure and deploy AWS EC2 Image Builder to build a sample AMI'
});
