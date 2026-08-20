# Amazon EC2 Image Builder Samples

Working samples for [Amazon EC2 Image Builder](https://aws.amazon.com/image-builder/): CloudFormation templates, CDK applications, AWSTOE components, and container build scripts. Each sample is self-contained with its own README.

This repository is maintained by the EC2 Image Builder service team. Samples are provided as-is - we review issues and pull requests on a best-effort basis.

## Start here

New to Image Builder? Build your first image from the console using the [Get started tutorial](https://docs.aws.amazon.com/imagebuilder/latest/userguide/getting-started-image-builder.html) - it's the fastest way to understand the pipeline / recipe / component model before picking up infrastructure-as-code.

From there:

1. [CloudFormation/Linux/amazon-linux-2-with-latest-ssm-agent](CloudFormation/Linux/amazon-linux-2-with-latest-ssm-agent/) - a minimal one-shot AMI build in a single CloudFormation template (no pipeline - the CDK sample below adds one).
2. [CDK/Linux/hello-world](CDK/Linux/hello-world/) - the same concepts in CDK, driven by a JSON configuration that supports multiple pipelines.
3. [CloudFormation/Windows/cascading-images-with-dotnet-web-application](CloudFormation/Windows/cascading-images-with-dotnet-web-application/) - the "golden image hierarchy" pattern: a baseline image pipeline feeding an application image pipeline.

## Sample index

### CloudFormation - Linux AMIs

| Sample | What it shows |
|---|---|
| [amazon-linux-2023-attestable-image](CloudFormation/Linux/amazon-linux-2023-attestable-image/) | Attestable AL2023 AMIs with dm-verity and NitroTPM PCR measurements, built with custom image workflows |
| [amazon-linux-2-with-latest-ssm-agent](CloudFormation/Linux/amazon-linux-2-with-latest-ssm-agent/) | Installing the latest SSM Agent before the build starts, using `UserDataOverride` |
| [ubuntu-2004-with-latest-ssm-agent](CloudFormation/Linux/ubuntu-2004-with-latest-ssm-agent/) | The same pre-build SSM Agent pattern for Ubuntu |
| [ubuntu-with-net6](CloudFormation/Linux/ubuntu-with-net6/) | Attaching the AWS managed .NET SDK component to an Ubuntu AMI recipe |

### CloudFormation - Windows AMIs

| Sample | What it shows |
|---|---|
| [cascading-images-with-dotnet-web-application](CloudFormation/Windows/cascading-images-with-dotnet-web-application/) | Golden image hierarchy - a baseline Windows image stack whose exported Image ARN feeds an application image stack; NSSM-managed Windows service |
| [windows-server-2016-with-vscode](CloudFormation/Windows/windows-server-2016-with-vscode/) | A custom component with build, validate, and test phases that installs an application (VS Code) on Windows |
| [windows-server-with-latest-ssm-agent](CloudFormation/Windows/windows-server-with-latest-ssm-agent/) | Pre-build SSM Agent installation on Windows via `UserDataOverride` (PowerShell) |

### CloudFormation - container images

| Sample | What it shows |
|---|---|
| [amazon-linux-2-with-helloworld](CloudFormation/Docker/amazon-linux-2-with-helloworld/) | A complete container recipe: Dockerfile template, custom component, and distribution to Amazon ECR |
| [ubuntu-dotnet-web-application](CloudFormation/Docker/ubuntu-dotnet-web-application/) | A container image hosting a .NET web application pulled from S3, on a daily dependency-update schedule |
| [windows-dotnet-web-application](CloudFormation/Docker/windows-dotnet-web-application/) | A Windows Server container image hosting a .NET web application |

### CDK

| Sample | What it shows |
|---|---|
| [accelerated-build-asg](CDK/Linux/accelerated-build-asg/) | Accelerated builds using pre-warmed instances in an Auto Scaling group, with custom image workflows and `WaitForAction` steps |
| [hello-world](CDK/Linux/hello-world/) | Configuration-driven pipelines in CDK TypeScript: components loaded from local files or managed component ARNs, SNS build notifications, and the output AMI ID recorded in an SSM parameter |

### Components (AWSTOE)

| Sample | Platform | What it shows |
|---|---|---|
| [ansible-playbook-execution-amazon-linux-2](Components/Linux/ansible-playbook-execution-amazon-linux-2/) | Linux | Running an Ansible playbook from S3 inside a build component |
| [chef-recipe-execution-linux](Components/Linux/chef-recipe-execution-linux/) | Linux | Running Chef recipes in local mode, with install handled by the omnitruck script |
| [inspec-recipe-execution-linux](Components/Linux/inspec-recipe-execution-linux/) | Linux | A test-phase-only component: run InSpec compliance tests and upload the report to S3 |
| [orca-security-scan-test-component-linux](Components/Linux/orca-security-scan-test-component-linux/) | Linux | A third-party (Orca Security) vulnerability scan as a test component |
| [ram-share-image-component-linux](Components/Linux/ram-share-image-component-linux/) | Linux | Multi-account golden image distribution using AWS RAM and a versionless cross-account image ARN as the parent image |
| [wordpress-recipes-linux](Components/Linux/wordpress-recipes-linux/) | Linux | Progressive components baking a WordPress stack into an AMI |
| [chef-recipe-execution-windows](Components/Windows/chef-recipe-execution-windows/) | Windows | The Chef pattern, PowerShell variant |
| [configure-wsus-server](Components/Windows/configure-wsus-server/) | Windows | Pointing Windows Update at a WSUS server via the registry - useful for isolated-subnet builds |
| [create-local-user](Components/Windows/create-local-user/) | Windows | Creating a local Windows user with the password pulled from Secrets Manager at build time - no secrets in the component document |
| [inspec-recipe-execution-windows](Components/Windows/inspec-recipe-execution-windows/) | Windows | InSpec compliance testing in the test phase on Windows |

### Containers

| Sample | What it shows |
|---|---|
| [Containers/Scripts](Containers/Scripts/) | Reproducing an Image Builder container build locally for debugging - fetches your container recipe, renders the Dockerfile template, and runs the component with AWSTOE |

### Lambda

| Sample | What it shows |
|---|---|
| [lambda/latest_image_tracker](lambda/latest_image_tracker/) | SNS-triggered Lambda that keeps a "latest AMI" SSM parameter updated after each build. Note: Image Builder distribution configurations can now [write output AMI IDs to SSM parameters natively](https://docs.aws.amazon.com/imagebuilder/latest/userguide/cr-upd-ami-distribution-settings.html) - prefer that for new work |

## Which IAM role does what

IAM setup is the most common source of first-build failures. Image Builder uses several distinct roles - this table names each one and the AWS managed policy that belongs on it.

| Role | Attached policies | Used for |
|---|---|---|
| Build instance profile | `EC2InstanceProfileForImageBuilder` + `AmazonSSMManagedInstanceCore` (add `EC2InstanceProfileForImageBuilderECRContainerBuilds` for container builds) | The EC2 instance that builds and tests your image. Components run with these permissions - S3 downloads, SSM parameter reads, etc. all come from here |
| Service-linked role (`AWSServiceRoleForImageBuilder`) | Managed by the service | Created automatically the first time you use Image Builder. Don't pass it as an execution role |
| Execution role | `EC2ImageBuilderExecutionPolicy` | Custom workflows, SSM parameter output, and ISO imports. Create your own role with this policy rather than passing the service-linked role. Note that both this policy and the service-linked role scope `ssm:PutParameter` to the `/imagebuilder/*` parameter path - writing output parameters outside that path requires a custom execution role with an added inline statement, since the service-linked role can't be modified |
| Lifecycle execution role | `EC2ImageBuilderLifecycleExecutionPolicy` | Lifecycle policies that deprecate, disable, and delete old images |
| Cross-account distribution role (`EC2ImageBuilderDistributionCrossAccountRole`) | `Ec2ImageBuilderCrossAccountDistributionAccess` + documented inline policies | Created in *target* accounts so distribution can copy images, update launch templates, and write SSM parameters there |

## Additional learning resources

* [EC2 Image Builder User Guide](https://docs.aws.amazon.com/imagebuilder/latest/userguide/index.html)
* [EC2 Image Builder API Reference](https://docs.aws.amazon.com/imagebuilder/latest/APIReference/index.html)
* [EC2 Image Builder CLI Reference](https://docs.aws.amazon.com/cli/latest/reference/imagebuilder/index.html)
* [EC2 Image Builder CloudFormation Reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/AWS_ImageBuilder.html)
* [AWSTOE component manager](https://docs.aws.amazon.com/imagebuilder/latest/userguide/toe-component-manager.html) - develop and test components locally before using them in a pipeline
* [EC2 Image Builder document history](https://docs.aws.amazon.com/imagebuilder/latest/userguide/doc-history.html) - a dated list of feature launches, useful for catching capabilities added since you last looked

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md) for how to report issues and submit pull requests.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
