FROM public.ecr.aws/lambda/nodejs:20

# RUN apt-get update && apt-get install gzip make tar perl
RUN dnf install -y gzip make tar perl

COPY entrypoint.sh ./

# Fix permissions
RUN chmod +x entrypoint.sh

COPY package.json package-lock.json index.js ${LAMBDA_TASK_ROOT}

RUN npm install

CMD [ "index.handler" ]