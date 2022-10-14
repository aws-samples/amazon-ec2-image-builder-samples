# Amazon EC2 Image Builder Samples

This repository contains samples that demonstrate various aspects of the [Amazon EC2 Image Builder](https://aws.amazon.com/image-builder/) service.

## Content

### CloudFormation

The ```CloudFormation``` folder contains sample EC2 Image Builder CloudFormation templates. These samples demonstrate how to deploy EC2 Image Builder infrastructure to AWS accounts using CloudFormation.

### CDK

The ```CDK``` folder contains sample EC2 Image Builder Cloud Development Kit. These samples demonstrate how to deploy EC2 Image Builder infrastructure to AWS accounts using Cloud Development Kit.

### Components

The ```Components``` folder contains sample Image Builder components. The samples demonstrate how certain features of the component management application work, or how to execute certain workflows, such as invoking ```ansible-playbook``` or ```chef-client``` within a component.

### Containers

The ```Containers``` folder contains scripts used by EC2 Image Builder during docker image build. The samples demonstrate how to build container images following the steps followed by EC2 Image Builder.


## Additional Learning Resources

### Links

* [Amazon EC2 Image Builder](https://aws.amazon.com/image-builder/)
* [AWS Cloud Development Kit (CDK)](https://docs.aws.amazon.com/cdk/index.html)
* [EC2 Image Builder Documentation](https://docs.aws.amazon.com/imagebuilder/)
  * [EC2 Image Builder User Guide](https://docs.aws.amazon.com/imagebuilder/latest/userguide/index.html)
  * [EC2 Image Builder API Reference](https://docs.aws.amazon.com/imagebuilder/latest/APIReference/index.html)
  * [EC2 Image Builder CLI Reference](https://docs.aws.amazon.com/cli/latest/reference/imagebuilder/index.html)
  * [EC2 Image Builder CloudFormation Reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/AWS_ImageBuilder.html)

### Blogs

* [Automate OS Image Build Pipelines with EC2 Image Builder](https://aws.amazon.com/blogs/aws/automate-os-image-build-pipelines-with-ec2-image-builder/) (02 December 2019)
* [Executing Ansible playbooks in your Amazon EC2 Image Builder pipeline](https://aws.amazon.com/blogs/compute/executing-ansible-playbooks-in-your-amazon-ec2-image-builder-pipeline/) (08 July 2020)
* [Create immutable servers using EC2 Image Builder and AWS CodePipeline](https://aws.amazon.com/blogs/mt/create-immutable-servers-using-ec2-image-builder-aws-codepipeline/) (07 January 2021)

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
