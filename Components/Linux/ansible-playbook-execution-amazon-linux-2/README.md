# Ansible Playbook Execution on Amazon Linux 2

This is a sample component that demonstrates how to download and execute an Ansible playbook against Amazon Linux 2.

## Walkthrough

1. Upload the ```playbook.yml``` file to an S3 bucket.
2. Within the ```component.yml``` document, update the ```DownloadPlaybook``` step with the S3 path where you uploaded ```playbook.yml```.
3. Create a new Image Builder component with the contents of  ```component.yml```.
4. Add the component to an image recipe that targets Amazon Linux 2.
5. Use the image recipe to create an image, either directly or with an image pipeline.
