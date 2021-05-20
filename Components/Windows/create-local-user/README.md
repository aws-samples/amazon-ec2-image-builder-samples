# Creation of a local Windows user account with RDP login permissions

This is a sample component that demonstrates how to create a local Windows user account without Administrator permissions and grant RDP login privileges to this account. This can be useful in situation where you build a jump host that you do not want to join into an Active Directory and where you do not want the users to have admin access, especially if you manage your configuration changes to the machines via an EC2 Image Builder pipeline.

This component activates the AWS Tools for Powershell for Windows [documentation](https://docs.aws.amazon.com/powershell/latest/userguide/pstools-welcome.html) which are already pre-installed on the AWS Managed AMIs for Windows Server 2019 and probably other versions as well. This is done so that the Powershell part of this component can interact with AWS Secrets Manager to retrieve the password for this users, as we did not want to have it written down in the document. To allow the build instance to retrieve the password for the user from AWS Secrets Manager the IAM role assigned to it via the EC2 Image Builder Infrastructure configuration needs to have a policy attached which allows the action ```secretsmanager:GetSecretValue``` for the specified secret.

As the password is set during the runtime of the pipeline the instances deployed from the final AMI don't need access to this secret. 

## Prerequisites

- a Secret created in AWS Secrets Manager that stores the password for the local Windows user account
- an IAM policy that allows the build instance to fetch the secret by allowing the ```secretsmanager:GetSecretValue``` API action
- (if set) The resource policy on the secret needs to allow the build instance IAM role to read it
- (if set) The resource policy on the KMS key protecting the secret needs to allow the build instance IAM role to use it for decryption
- a Windows image build pipeline (This component was tested with the AWS provided Windows AMIs for Server 2019)

## Walkthrough

1. In AWS Secrets Manager: Create a Secret to store the password for the local user. The secret key needs to be named ```password```
2. Within the ```create-local-user.yml``` document: Update the constant ```Username``` at the beginning of the document to set the desired login name of the user
3. Within the ```create-local-user.yml``` document: Update the constant ```FullName``` at the beginning of the document to set the full name of the user
4. Within the ```create-local-user.yml``` document: Update the constant ```Description``` at the beginning of the document to set the description for the user
5. Within the ```create-local-user.yml``` document: Update the constant ```PasswordSecret``` at the beginning of the document to specify the secret name or ARN the password shoudl be fetched from
6. Create a new EC2 Image Builder component with the contents of ```create-local-user.yml```
7. Add the component to an image recipe that targets Windows Server 2019 (This is the tested one, other versions may work, too)
8. Use the image recipe to create an image

## Sample IAM policy for secret access

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowSecretRetrieval",
            "Effect": "Allow",
            "Action": "secretsmanager:GetSecretValue",
            "Resource": "arn:aws:secretsmanager:eu-central-1:1234456789012:secret:Jumphost/RdpUser-ylVQMh"
        }
    ]
}
```