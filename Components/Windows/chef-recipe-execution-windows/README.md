# Chef Client Execution on Windows

This is a sample component that demonstrates how to download and execute a Chef recipe against a Windows server. This sample will install Chef using the Chef Software Install script. For more information about the installation script, review the [documentation](https://docs.chef.io/packages/#chef-software-install-script).

## Walkthrough

1. Upload the ```recipe.rb``` file to an S3 bucket.
2. Within the ```component.yml``` document, update the ```DownloadRecipe``` step with the S3 path where you uploaded ```recipe.rb```.
3. Create a new Image Builder component with the contents of ```component.yml```.
4. Add the component to an image recipe that targets Windows Server 2012 R2, 2016 or 2019.
5. Use the image recipe to create an image, either directly or with an image pipeline.
