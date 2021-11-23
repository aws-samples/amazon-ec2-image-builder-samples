# Install SQL Server from Config + ISO Media on S3 for BYOL SQL

This component installs SQL Server from your own Media/ISO, and using a sample configuration file to determine the installation settings. The component relies on two parameters, ```S3bucket``` and ```SQLiso``` to properly install SQL using Image Builder. This component has been tested with SQL Server 2019 Enterprise media, and Windows Server 2016 and 2019 as 

## Prerequisites

- S3 Bucket with:
  - SQL Server installation media as an ISO file
  - Custom or provided sample ConfigurationFile.ini file. [More on Installing SQL Server with a Configuration File](https://docs.microsoft.com/en-us/sql/database-engine/install-windows/install-sql-server-using-a-configuration-file?view=sql-server-ver15)

## Walkthrough

- Create a new Image Builder Component using the ```install-sql-server.yaml``` file as a template
- Add our new component to a new or existing Image recipe
  - Make sure to set the Input parameters to the S3 bucket name and ISO name before saving
  - Since we are installing SQL, use a non-SQL Base image, like windows-server-2019-english-full-base-x86
- Grant S3 Read permissions to the IAM role used by the Image pipeline, otherwise the pipeline will not be able to download the ISO and Config

## Troubleshooting

### Image build shows status Failed
For a more detailed error, check the Log stream that gets created on every output image produced.

### 403 Forbidden during S3Download step
Make sure you have granted permissions for the IAM Role used by Image Builder to download from S3. By default, the EC2InstanceProfileForImageBuilder does not have S3 access. Attaching the AmazonS3ReadOnlyAccess managed policy is a quick fix, but can also scoped to the specific bucket that holds the ISO and Config for least privilege.
