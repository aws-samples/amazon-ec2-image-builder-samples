# Switch Windows Update source to a WSUS server

This is a sample component that demonstrates how to switch the update source of Windows Update to a WSUS server instead of the public Microsoft Update servers by modifying the system registry. This is helpful if your image build pipeline is running in an isolated network segment without direct internet access or if you want to have more granular controls about the update release process.

Usually the configuration of a WSUS server is done centrally via Active Directory Group Policy Objects (GPOs). In the case of an EC2 image builder pipeline GPOs usually don't apply as the build instance will not be joined to the active directory so this component takes the approach to modify the registry keys.

The component is based on this article in the Microsoft [documentation](https://docs.microsoft.com/de-de/security-updates/windowsupdateservices/21669493).

## Prerequisites

- a WSUS server that can be reached from the build instance
- a Windows image build pipeline (This component was tested with the AWS provided Windows AMIs for Server 2016, 2019, and 2004)
- a WSUS Computer group where the build instances will be assigned to (This component only supports client-side targeting)

## Walkthrough

1. On the WSUS server: Create a computer group for your build instances and approve the desired patches
2. Within the ```configure-wsus-server.yml``` document: Update the constant ```WUServer``` at the beginning of the document with the http or https URL of your WSUS server
3. Within the ```configure-wsus-server.yml``` document: Update the constant ```WUStatusServer``` at the beginning of the document with the http or https URL of your WSUS Status server (usually the same as the WUServer)
4. Within the ```configure-wsus-server.yml``` document: Update the constant ```TargetGroup``` at the beginning of the document with the name of the target group
5. Create a new EC2 ImageBuilder build component with the contents of ```configure-wsus-server.yml```
6. Add the component to an image recipe that targets Windows Server 2016, 2019, or 2004 (These are the tested ones, other versions may work, too). **Please make sure that this component runs before any Windows Update components.** Otherwise the update step might fail in an isolated subnet.
7. Use the image recipe to create an image, either directly or with an image pipeline.
