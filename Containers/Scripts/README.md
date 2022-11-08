# Build Amazon EC2 Image Builder container images on local.

This folder contains sample scripts that demonstrate how to build a docker container image locally on a Linux machine. These steps are part of the EC2 Image Builder build process.

```Note: The scripts used might not be the latest, as EC2 Image Builder continously improves the build process. The intent is to provide a general overview of the EC2 Image Builder container build process.```


## Pre-requisites
To run the steps in this README, you will need:

1. An AWS account.
2. The following AWS Identity and Access Management (IAM) permission: imagebuilder:GetContainerRecipe (Use an IAM Role attached to an EC2 Instance, or an IAM User/Role on a local Linux machine).
3. An EC2 Image Builder component. **Note:** *Make sure to record the ARN for later use.*
4. An EC2 Image Builder container recipe. **Note:** *Make sure to record the ARN for later use.*
5. A Linux system or EC2 Linux instance where you run the scripts.
6. AWS CLI V2 installed. If you are using AWS CLI V1, you can either [uninstall](https://docs.aws.amazon.com/cli/v1/userguide/install-linux-al2017.html) or [update](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) to V2. Refer to troubleshooting section for more information.
7. AWS CLI version 2 installed on the Linux system or EC2 Linux instance where you run the scripts. 
   1. To verify the version you have installed, run the ```aws --version``` command. [Install AWS CLI version 2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) if it's not already installed or if you have version 1 installed, and run the aws --version command again.
   2. *Note:* If the version command still shows an older version after you installed version 2, you might need to run the following command to update the path for the root user: ```ln -sf /usr/local/bin/aws /usr/bin/aws```.


## Steps
1. Launch a Linux EC2 Instance if you are not using a Linux system. For more information, see [Launch EC2 instance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/EC2_GetStarted.html#ec2-launch-instance).
2. Connect to the EC2 Instance using SSH. For more information, see [Access EC2 Instance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/AccessingInstancesLinux.html).
3. Run the ```bootstrap-script-linux.sh``` script:
    1. Change the file permissions to allow you to run the script. ```chmod +x bootstrap-script-linux.sh```
    2. Run the script: ```./bootstrap-script-linux.sh```
    
    **Note**: *You might need elevated permissions to run the script. Use ```sudo su```.*

4. Update the AWS credentials to allow access to Image Builder resources from the location where the script runs, as follows.
    1. **From a local machine**, Use the ```aws configure``` command to set up your credentials. For more information, see [Configure AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-quickstart.html).
    2. **From an EC2 instance**, You can use ```aws configure``` command or attach an IAM role that has Image Builder permissions to the instance. For more information, see [IAM roles for EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html).
5. In the ```container-build-script.sh``` file, replace the following:
    1. Replace ```Image-Builder-Component-ARN``` with your build component ARN.
    2. Replace ```Container-Recipe-ARN``` with your container recipe ARN.
    3. Replace ```Region``` the AWS Region where you want to build.
6. Execute ```container-build-script.sh```
    1. Update the file permissions to allow you to run the script. ```chmod +x container-build-script.sh```
    2. Run the script. ```./container-build-script.sh```
    
    **Note**: *You might need sudo permissions to run the script. Use ```sudo su```*.

## Validation and Troubleshooting
1. Verify that the container was created: ```docker image ls```
2. To verify that the script ran successfully, check the exit code of the container: ```docker ps -a```
3. Verify that the expected files were modified during the container build: ```docker diff <CONTAINER_ID>```
    **Note:**  *Use the ```docker ps -a``` command to find the ```CONTAINER_ID```*
4. After you have verified the diff in the docker image, run the following commands to build the container:
    1. ```docker commit <CONTAINER_ID> image_for_testing```
    2. ```docker run -it --name troubleshooting_container image_for_testing /bin/bash```
    
## Cleanup
If you are running from an EC2 instance, Follow these [steps](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/terminating-instances.html#terminating-instances-console) to terminate the instance.
**Note:** *Remember to save your data before you terminate the EC2 Instance.*
