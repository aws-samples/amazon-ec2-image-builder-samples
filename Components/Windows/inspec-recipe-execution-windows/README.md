# Chef Inspec Execution on Windows

This is a sample component that demonstrates how to download and execute a Chef Inspec recipe against a Windows 2016 server. This document downloads the Chef InSpec installer from Amazon S3 and installs it. It then downloads the test cases from Amazon S3 and performs the tests. After running the test cases, it returns the exit code of the process and uploads the test report to Amazon S3. The Image Builder pipeline either progresses or fails based on the value of the exit code. 

For more information on Chef Inspec, visit [https://docs.chef.io/inspec/](https://docs.chef.io/inspec/)

## Prerequisites

1. Download the [Chef InSpec installer](https://www.inspec.io/downloads/) and upload it to an S3 bucket.
2. An EC2 Image Builder pipeline with an IAM role configured that provides permissions for the following functions:
     1. Download the Chef InSpec installer and test cases from an S3 bucket
     2. Upload the test results to an S3 bucket

## Walkthrough

1. Upload the ```inspec-test-cases.rb``` file to an S3 bucket.
2. Within the ```inspec-test-windows-component.yml``` document, update the ```<S3_PATH_TO_INSPEC_INSTALLER.MSI>``` variable in the ```Download_InSpec_Installer``` step with the S3 path where you uploaded the Chef Inspec installer.
3. Within the ```inspec-test-windows-component.yml``` document, update the ```<S3_PATH_TO_INSPEC_TEST.RB>``` variable in the ```Download_InSpec_Tests``` step with the S3 path where you uploaded the ```inspec-test-cases.rb``` document.
4. Within the ```inspec-test-windows-component.yml``` document, update the ```<S3_BUCKET_NAME_REPORT_OUTPUT>``` in the step ```Run_InSpec_Tests``` with the name of the S3 bucket where the Chef Inspec test results should be uploaded to
5. Create a new Image Builder Test component with the contents of ```inspec-test-windows-component.yml```.
6. Add the component to an image recipe that targets Windows Server 2016
7. Use the image recipe to create an image, either directly or with an image pipeline.

After the successful completion of the image builder pipeline, the InSpec test report can be downloaded from the Amazon S3 location specified in the document.


