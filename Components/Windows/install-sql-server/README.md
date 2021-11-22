# Install SQL Server from Config + ISO Media on S3

This component installs SQL Server from your own Media/ISO, and using a sample configuration file to determine the installation settings. The component relies on two parameters, ```S3bucket``` and ```SQLiso``` to properly install SQL using Image Builder.

## Prerequisites

- SQL Server installation media as an ISO file
- Custom or provided sample ConfigurationFile.ini file [More on Installing SQL Server with a Configuration File](https://docs.microsoft.com/en-us/sql/database-engine/install-windows/install-sql-server-using-a-configuration-file?view=sql-server-ver15)
- S3 Read access added to the EC2 Instance Profile for Image Builder role, either via managed policy ```AmazonS3ReadOnlyAccess``` or via more specific policies

## Walkthrough

- Create a new Image Builder Component using the yaml file 
- Upload SQL Server ISO and ConfigurationFile.ini to an S3 bucket
- Add the new component to a recipe and make sure to set the Input parameters on the Components' Step 1
