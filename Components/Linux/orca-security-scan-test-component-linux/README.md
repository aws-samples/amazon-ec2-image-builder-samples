# Scan linux-based images using Orca Security API

This is a test component that uses Orca Security API to scan and detect known vulnerabilities in linux-based images.

## Walkthrough

1. Create a new folder in an S3 bucket and upload `orca_scan_test.sh` and `scan_vm.sh` files to it.
2. Within the `test_component.yml` document
      - update the `DownloadFiles` step with the S3 path where you uploaded the files from step 1.
      - update the `RunOrcaScan` step with an orca `api token`.
3. Create a new Image Builder test component with the contents of `test_component.yml`.
4. Add the component to an image recipe that targets a Linux distribution.

## Test Options
`orca_scan_test.sh` script provides options that let you configure some scan parameters.
See script usage:
```
Usage: orca_scan_test.sh --api-token API_TOKEN [options]

options:

  -h, --help                        print help message and exit
  -s, --score-threshold SCORE       the score below which the test will fail, valid range is 1-4 [default: 2]
  -t, --timeout TIMEOUT             the timeout for the scan in seconds [default: 1800]
  -d, --debug                       debug mode [default: off]
```

## IAM Requirements
As this component runs the S3Download action module with multiple files, the IAM role associated with your image builder pipeline must have the following permissions:

> s3:ListBucket against the bucket/object (for example, arn:aws:s3:::BucketName) and s3:GetObject against the bucket/object (for example, arn:aws:s3:::BucketName/*).
> 
> -- [From AWS documentation](https://docs.aws.amazon.com/imagebuilder/latest/userguide/image-builder-action-modules.html#image-builder-action-modules-s3download)
