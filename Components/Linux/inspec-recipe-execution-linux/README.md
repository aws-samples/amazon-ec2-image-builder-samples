# Chef Inspec Execution on Linux

This is a sample component that demonstrates how to download and execute a Chef Inspec recipe against a Linux server. This sample will install inspec using the Chef Software Install script. It then downloads the test cases from Amazon S3 and performs the tests. After running the test cases, it returns the exit code of the process and uploads the test report to Amazon S3. The Image Builder pipeline either progresses or fails based on the value of the exit code. 

For more information about the installation script, review the Chef [documentation](https://docs.chef.io/packages/#chef-software-install-script).

For more information on Chef Inspec, visit [https://docs.chef.io/inspec/](https://docs.chef.io/inspec/)

## Prerequisites

1. An EC2 Image Builder pipeline with an IAM role configured that provides permissions for the following functions:
     1. Download test cases from an S3 bucket
     2. Upload the test results report to an S3 bucket

## Walkthrough

1. Upload the ```inspec-test-cases.rb``` file to an S3 bucket.
2. Within the ```inspec-test-linux-component.yml``` document, update the ```<S3_PATH_TO_INSPEC_TEST.RB>``` variable in the ```ComplianceScriptSource``` constants with the S3 path where you uploaded the ```inspec-test-cases.rb``` document.
3. Within the ```inspec-test-linux-component.yml``` document, update the ```<S3_PATH_TO_INSPEC_REPORT_LOCATION>``` in the step ```UploadComplianceReportToS3``` with the name of the S3 bucket where the Chef Inspec test results should be uploaded to
4. Create a new Image Builder Test component with the contents of ```inspec-test-linux-component.yml```.
5. Add the component to an image recipe that targets linux Server 2016
6. Use the image recipe to create an image, either directly or with an image pipeline.

After the successful completion of the image builder pipeline, the InSpec test report can be downloaded from the Amazon S3 location specified in the document.


